import { Command } from "commander";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

export const restartCommand = new Command("restart")
  .description("Gracefully stop and restart Clawster (preserves sessions)")
  .action(async () => {
    if (platform() === "darwin" && existsSync(PLIST_PATH)) {
      const uid = process.getuid?.() ?? 501;
      console.log("Restarting via launchctl kickstart -k (waits for graceful drain)...");
      const proc = Bun.spawn(
        ["launchctl", "kickstart", "-k", "-s", `gui/${uid}/${LABEL}`],
        { stdout: "inherit", stderr: "inherit" },
      );
      await proc.exited;
      if (proc.exitCode === 0) {
        console.log("Clawster restarted. Sessions resume from ~/.clawster/sessions/.");
      } else {
        console.error(
          `Restart failed (exit ${proc.exitCode}). Check: launchctl print gui/${uid}/${LABEL}`,
        );
      }
      return;
    }

    if (platform() === "linux") {
      const servicePath = join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE);
      if (existsSync(servicePath)) {
        console.log("Restarting via systemctl --user restart...");
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
