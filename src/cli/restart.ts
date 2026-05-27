import { Command } from "commander";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

export const restartCommand = new Command("restart")
  .description("Restart Clawster atomically (preserves sessions; for plist changes, use 'clawster daemon install')")
  .action(async () => {
    if (platform() === "darwin" && existsSync(PLIST_PATH)) {
      const uid = process.getuid?.() ?? 501;

      // Ensure the service is loaded. If `clawster stop` was run earlier the
      // service may be unloaded, in which case bootstrap puts it back into
      // launchd's registry (and RunAtLoad=true starts it). If already loaded,
      // bootstrap exits non-zero, which is fine — kickstart below handles it.
      const bootstrap = Bun.spawn(
        ["launchctl", "bootstrap", `gui/${uid}`, PLIST_PATH],
        { stdout: "ignore", stderr: "ignore" },
      );
      await bootstrap.exited;

      // kickstart -k is one atomic signal to launchd: kill the running process
      // and respawn it. Critically, this survives the caller dying mid-flight
      // — `clawster restart` is often invoked from inside the daemon (Telegram
      // → Zero agent), so a two-step bootout+bootstrap dance leaves the
      // service unloaded if the caller is killed between commands.
      // Tradeoff: kickstart does NOT pick up plist changes (env vars, args).
      // To reload the plist, run `clawster daemon install` again.
      console.log("Restarting via launchctl kickstart -k...");
      const kick = Bun.spawn(
        ["launchctl", "kickstart", "-k", `gui/${uid}/${LABEL}`],
        { stdout: "inherit", stderr: "inherit" },
      );
      await kick.exited;
      if (kick.exitCode === 0) {
        console.log("Clawster restarted. Sessions resume from ~/.clawster/sessions/.");
      } else {
        console.error(
          `Restart failed (kickstart exit ${kick.exitCode}). Check: launchctl print gui/${uid}/${LABEL}`,
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
