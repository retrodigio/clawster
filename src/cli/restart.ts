import { Command } from "commander";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

export const restartCommand = new Command("restart")
  .description("Gracefully stop and restart Clawster (preserves sessions, reloads plist/unit)")
  .action(async () => {
    if (platform() === "darwin" && existsSync(PLIST_PATH)) {
      const uid = process.getuid?.() ?? 501;
      // bootout + bootstrap reloads the plist (picks up EnvironmentVariables changes).
      // kickstart -k would restart the process but keep the stale loaded config.
      console.log("Restarting via launchctl bootout + bootstrap (reloads plist)...");
      const bootout = Bun.spawn(
        ["launchctl", "bootout", `gui/${uid}`, PLIST_PATH],
        { stdout: "inherit", stderr: "inherit" },
      );
      await bootout.exited;
      // bootout returns non-zero if the service wasn't loaded; that's fine.
      const bootstrap = Bun.spawn(
        ["launchctl", "bootstrap", `gui/${uid}`, PLIST_PATH],
        { stdout: "inherit", stderr: "inherit" },
      );
      await bootstrap.exited;
      if (bootstrap.exitCode === 0) {
        console.log("Clawster restarted. Sessions resume from ~/.clawster/sessions/.");
      } else {
        console.error(
          `Restart failed (bootstrap exit ${bootstrap.exitCode}). Check: launchctl print gui/${uid}/${LABEL}`,
        );
      }
      return;
    }

    if (platform() === "linux") {
      const servicePath = join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE);
      if (existsSync(servicePath)) {
        // daemon-reload picks up unit file changes (e.g. Environment= edits)
        // before restart, matching the macOS bootout+bootstrap behavior.
        console.log("Reloading systemd units and restarting...");
        const reload = Bun.spawn(
          ["systemctl", "--user", "daemon-reload"],
          { stdout: "inherit", stderr: "inherit" },
        );
        await reload.exited;
        const proc = Bun.spawn(
          ["systemctl", "--user", "restart", SYSTEMD_SERVICE],
          { stdout: "inherit", stderr: "inherit" },
        );
        await proc.exited;
        if (proc.exitCode === 0) {
          console.log("Clawster restarted. Sessions resume from ~/.clawster/sessions/.");
        } else {
          console.error(`Restart failed. Check: systemctl --user status ${SYSTEMD_SERVICE}`);
        }
        return;
      }
    }

    console.error(
      "No installed daemon found. Run 'clawster stop' then 'clawster start' manually, or install the daemon with 'clawster daemon install'.",
    );
    process.exit(1);
  });
