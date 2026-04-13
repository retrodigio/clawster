import { Command } from "commander";
import { existsSync } from "fs";
import { mkdir, unlink } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

const LABEL = "com.clawster.daemon";
const PLIST_NAME = `${LABEL}.plist`;
const LAUNCH_AGENTS_DIR = join(homedir(), "Library", "LaunchAgents");
const PLIST_PATH = join(LAUNCH_AGENTS_DIR, PLIST_NAME);

function generatePlist(bunPath: string, cliPath: string, home: string): string {
  const logsDir = join(home, "logs");
  const userHome = homedir();
  // Build a comprehensive PATH that includes all common binary locations
  const pathDirs = new Set<string>();
  // Add directories of detected binaries
  pathDirs.add(join(userHome, ".local", "bin")); // claude CLI
  pathDirs.add(join(userHome, ".bun", "bin"));   // bun
  // Add standard system paths
  pathDirs.add("/usr/local/bin");
  pathDirs.add("/usr/bin");
  pathDirs.add("/bin");
  // Add node paths
  pathDirs.add("/usr/local/opt/node@22/bin");
  pathDirs.add(join(userHome, ".nvm", "versions", "node")); // nvm
  // Add the directory of the detected bun binary
  const bunDir = bunPath.substring(0, bunPath.lastIndexOf("/"));
  if (bunDir) pathDirs.add(bunDir);

  const pathString = [...pathDirs].join(":");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${bunPath}</string>
    <string>${cliPath}</string>
    <string>start</string>
    <string>--foreground</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${home}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathString}</string>
    <key>HOME</key>
    <string>${userHome}</string>
  </dict>
  <key>KeepAlive</key>
  <true/>
  <key>RunAtLoad</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>StandardOutPath</key>
  <string>${join(logsDir, "clawster.log")}</string>
  <key>StandardErrorPath</key>
  <string>${join(logsDir, "clawster.error.log")}</string>
</dict>
</plist>`;
}

export const daemonCommand = new Command("daemon").description(
  "Manage the Clawster launchd daemon"
);

// clawster daemon install
daemonCommand
  .command("install")
  .description("Install the launchd daemon")
  .action(async () => {
    const home = getClawsterHome();

    // Detect bun path
    const whichProc = Bun.spawn(["which", "bun"], { stdout: "pipe" });
    const bunPath = (await new Response(whichProc.stdout).text()).trim();
    await whichProc.exited;
    if (!bunPath) {
      console.error("Could not find bun in PATH.");
      process.exit(1);
    }

    // CLI entry point path
    const cliPath = join(import.meta.dir, "index.ts");

    // Ensure logs directory exists
    await mkdir(join(home, "logs"), { recursive: true });

    // Ensure LaunchAgents directory exists
    await mkdir(LAUNCH_AGENTS_DIR, { recursive: true });

    // Generate and write plist
    const plist = generatePlist(bunPath, cliPath, home);
    await Bun.write(PLIST_PATH, plist);
    console.log(`Plist written to ${PLIST_PATH}`);

    // Load the daemon
    const uid = process.getuid?.() ?? 501;
    const loadProc = Bun.spawn(
      ["launchctl", "bootstrap", `gui/${uid}`, PLIST_PATH],
      { stdout: "inherit", stderr: "inherit" }
    );
    await loadProc.exited;

    if (loadProc.exitCode === 0) {
      console.log("Daemon installed and loaded.");
      console.log("It will start automatically on login.");
    } else {
      // Might already be loaded; try kickstart
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
  });

// clawster daemon uninstall
daemonCommand
  .command("uninstall")
  .description("Uninstall the launchd daemon")
  .action(async () => {
    if (!existsSync(PLIST_PATH)) {
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
      await unlink(PLIST_PATH);
      console.log("Daemon uninstalled and plist removed.");
    } catch {
      console.log("Daemon unloaded but could not remove plist file.");
    }
  });
