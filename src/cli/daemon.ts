import { Command } from "commander";
import { existsSync } from "fs";
import { mkdir, unlink, writeFile } from "fs/promises";
import { homedir, platform } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

const LABEL = "com.clawster.daemon";
const PLIST_NAME = `${LABEL}.plist`;
const SYSTEMD_SERVICE = "clawster.service";

function isLinux(): boolean {
  return platform() === "linux";
}

function isMac(): boolean {
  return platform() === "darwin";
}

// --- macOS launchd ---

function getLaunchAgentsDir(): string {
  return join(homedir(), "Library", "LaunchAgents");
}

function getPlistPath(): string {
  return join(getLaunchAgentsDir(), PLIST_NAME);
}

/** Escape a string for safe inclusion in an XML <string> body. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

function generatePlist(bunPath: string, cliPath: string, home: string): string {
  const logsDir = join(home, "logs");
  const userHome = homedir();
  const pathDirs = new Set<string>();
  pathDirs.add(join(userHome, ".local", "bin"));
  pathDirs.add(join(userHome, ".bun", "bin"));
  pathDirs.add("/usr/local/bin");
  pathDirs.add("/usr/bin");
  pathDirs.add("/bin");
  pathDirs.add("/usr/local/opt/node@22/bin");
  pathDirs.add(join(userHome, ".nvm", "versions", "node"));
  const bunDir = bunPath.substring(0, bunPath.lastIndexOf("/"));
  if (bunDir) pathDirs.add(bunDir);

  const pathString = [...pathDirs].join(":");
  const x = xmlEscape;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${x(LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${x(bunPath)}</string>
    <string>${x(cliPath)}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${x(home)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${x(pathString)}</string>
    <key>HOME</key>
    <string>${x(userHome)}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${x(join(logsDir, "clawster.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${x(join(logsDir, "clawster.error.log"))}</string>
</dict>
</plist>`;
}

async function installLaunchd() {
  const home = getClawsterHome();

  const whichProc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
  const bunPath = (await new Response(whichProc.stdout).text()).trim();
  await whichProc.exited;
  if (!bunPath) {
    console.error("Could not find bun in PATH.");
    process.exit(1);
  }

  const cliPath = join(import.meta.dir, "index.ts");

  await mkdir(join(home, "logs"), { recursive: true });
  await mkdir(getLaunchAgentsDir(), { recursive: true });

  const plist = generatePlist(bunPath, cliPath, home);
  await Bun.write(getPlistPath(), plist);
  console.log(`Plist written to ${getPlistPath()}`);

  const uid = process.getuid?.() ?? 501;
  const loadProc = Bun.spawn(
    ["launchctl", "bootstrap", `gui/${uid}`, getPlistPath()],
    { stdout: "inherit", stderr: "inherit" }
  );
  await loadProc.exited;

  if (loadProc.exitCode === 0) {
    console.log("Daemon installed and loaded.");
    console.log("It will start automatically on login.");
  } else {
    console.log("Bootstrap returned non-zero (may already be loaded). Trying kickstart...");
    const kickProc = Bun.spawn(
      ["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`],
      { stdout: "inherit", stderr: "inherit" }
    );
    await kickProc.exited;
    if (kickProc.exitCode === 0) {
      console.log("Daemon restarted.");
    } else {
      console.error("Failed to start daemon. Check: launchctl print gui/" + uid + "/" + LABEL);
    }
  }
}

async function uninstallLaunchd() {
  const plistPath = getPlistPath();
  if (!existsSync(plistPath)) {
    console.log("Daemon is not installed.");
    return;
  }

  const uid = process.getuid?.() ?? 501;
  const proc = Bun.spawn(
    ["launchctl", "bootout", `gui/${uid}/${LABEL}`],
    { stdout: "inherit", stderr: "inherit" }
  );
  await proc.exited;

  try {
    await unlink(plistPath);
    console.log("Daemon uninstalled and plist removed.");
  } catch {
    console.log("Daemon unloaded but could not remove plist file.");
  }
}

// --- Linux systemd ---

function getSystemdDir(): string {
  return join(homedir(), ".config", "systemd", "user");
}

function getServicePath(): string {
  return join(getSystemdDir(), SYSTEMD_SERVICE);
}

function generateSystemdUnit(bunPath: string, cliPath: string, home: string): string {
  const logsDir = join(home, "logs");
  const userHome = homedir();

  // Build PATH for the service
  const pathDirs = [
    join(userHome, ".local", "bin"),
    join(userHome, ".bun", "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const bunDir = bunPath.substring(0, bunPath.lastIndexOf("/"));
  if (bunDir && !pathDirs.includes(bunDir)) pathDirs.unshift(bunDir);

  // systemd Environment= values are parsed with shell-like quoting. Wrap in
  // double quotes so values containing spaces (home dir with space, weird paths)
  // are handled correctly. Quote ExecStart fields too.
  return `[Unit]
Description=Clawster AI Agent Orchestrator
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart="${bunPath}" "${cliPath}" start --foreground
WorkingDirectory=${home}
Environment="PATH=${pathDirs.join(":")}"
Environment="HOME=${userHome}"
Restart=on-failure
RestartSec=10
StandardOutput=append:${join(logsDir, "clawster.log")}
StandardError=append:${join(logsDir, "clawster.error.log")}

[Install]
WantedBy=default.target
`;
}

async function installSystemd() {
  const home = getClawsterHome();

  const whichProc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
  const bunPath = (await new Response(whichProc.stdout).text()).trim();
  await whichProc.exited;
  if (!bunPath) {
    console.error("Could not find bun in PATH.");
    process.exit(1);
  }

  const cliPath = join(import.meta.dir, "index.ts");

  await mkdir(join(home, "logs"), { recursive: true });
  await mkdir(getSystemdDir(), { recursive: true });

  const unit = generateSystemdUnit(bunPath, cliPath, home);
  await writeFile(getServicePath(), unit);
  console.log(`Service unit written to ${getServicePath()}`);

  // Reload systemd and enable/start the service
  const reload = Bun.spawn(["systemctl", "--user", "daemon-reload"], {
    stdout: "inherit", stderr: "inherit",
  });
  await reload.exited;

  const enable = Bun.spawn(["systemctl", "--user", "enable", SYSTEMD_SERVICE], {
    stdout: "inherit", stderr: "inherit",
  });
  await enable.exited;

  const start = Bun.spawn(["systemctl", "--user", "start", SYSTEMD_SERVICE], {
    stdout: "inherit", stderr: "inherit",
  });
  await start.exited;

  if (start.exitCode === 0) {
    console.log("Daemon installed, enabled, and started.");
    console.log("It will start automatically on login.");
    console.log(`Check status: systemctl --user status ${SYSTEMD_SERVICE}`);
  } else {
    console.error(`Failed to start. Check: systemctl --user status ${SYSTEMD_SERVICE}`);
  }

  // Enable lingering so the user service runs even without an active session
  const linger = Bun.spawn(["loginctl", "enable-linger"], {
    stdout: "inherit", stderr: "inherit",
  });
  await linger.exited;
  if (linger.exitCode === 0) {
    console.log("Lingering enabled — service will run even when logged out.");
  }
}

async function uninstallSystemd() {
  const servicePath = getServicePath();
  if (!existsSync(servicePath)) {
    console.log("Daemon is not installed.");
    return;
  }

  const stop = Bun.spawn(["systemctl", "--user", "stop", SYSTEMD_SERVICE], {
    stdout: "inherit", stderr: "inherit",
  });
  await stop.exited;

  const disable = Bun.spawn(["systemctl", "--user", "disable", SYSTEMD_SERVICE], {
    stdout: "inherit", stderr: "inherit",
  });
  await disable.exited;

  try {
    await unlink(servicePath);
    console.log("Daemon stopped, disabled, and service file removed.");
  } catch {
    console.log("Daemon stopped but could not remove service file.");
  }

  // Reload after removing
  Bun.spawn(["systemctl", "--user", "daemon-reload"], {
    stdout: "inherit", stderr: "inherit",
  });
}

// --- CLI commands ---

export const daemonCommand = new Command("daemon").description(
  "Manage the Clawster daemon (launchd on macOS, systemd on Linux)"
);

daemonCommand
  .command("install")
  .description("Install the daemon for the current platform")
  .action(async () => {
    if (isMac()) {
      await installLaunchd();
    } else if (isLinux()) {
      await installSystemd();
    } else {
      console.error(`Unsupported platform: ${platform()}. Use 'clawster start --foreground' instead.`);
      process.exit(1);
    }
  });

daemonCommand
  .command("uninstall")
  .description("Uninstall the daemon for the current platform")
  .action(async () => {
    if (isMac()) {
      await uninstallLaunchd();
    } else if (isLinux()) {
      await uninstallSystemd();
    } else {
      console.error(`Unsupported platform: ${platform()}.`);
      process.exit(1);
    }
  });
