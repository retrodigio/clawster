import { Command } from "commander";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

export const startCommand = new Command("start")
  .description("Start the Clawster orchestrator")
  .option("--foreground", "Run in the foreground (no daemon)")
  .action(async (opts: { foreground?: boolean }) => {
    if (opts.foreground) {
      const { startServer } = await import("../core/server.ts");
      await startServer();
      return;
    }

    if (platform() === "darwin") {
      if (existsSync(PLIST_PATH)) {
        const uid = process.getuid?.() ?? 501;

        // Check whether the service is currently loaded. `launchctl print`
        // exits non-zero when the label is unknown to launchd (e.g. after
        // `clawster stop` did a bootout). In that case kickstart would fail —
        // we need to bootstrap first.
        const probe = Bun.spawn(
          ["launchctl", "print", `gui/${uid}/${LABEL}`],
          { stdout: "ignore", stderr: "ignore" },
        );
        await probe.exited;
        const loaded = probe.exitCode === 0;

        if (!loaded) {
          // Re-register the service with launchd. RunAtLoad=true *should* trigger
          // an automatic start, but in practice — especially right after a prior
          // bootout — launchd leaves it in `pended nondemand spawn = speculative`
          // without actually spawning. We always kickstart below to force it.
          const bootstrap = Bun.spawn(
            ["launchctl", "bootstrap", `gui/${uid}`, PLIST_PATH],
            { stdout: "inherit", stderr: "inherit" },
          );
          await bootstrap.exited;
          if (bootstrap.exitCode !== 0) {
            console.error(
              `Bootstrap failed (exit ${bootstrap.exitCode}). Check: launchctl print gui/${uid}/${LABEL}`,
            );
            return;
          }
        }

        const proc = Bun.spawn(["launchctl", "kickstart", `gui/${uid}/${LABEL}`], {
          stdout: "inherit",
          stderr: "inherit",
        });
        await proc.exited;
        if (proc.exitCode === 0) {
          console.log("Clawster daemon started via launchctl.");
        } else {
          console.error("Failed to start daemon. Check: launchctl print gui/" + uid + "/" + LABEL);
        }
      } else {
        console.log("No daemon installed. Run 'clawster daemon install' or use 'clawster start --foreground'.");
      }
    } else if (platform() === "linux") {
      const servicePath = join(homedir(), ".config", "systemd", "user", SYSTEMD_SERVICE);
      if (existsSync(servicePath)) {
        const proc = Bun.spawn(["systemctl", "--user", "start", SYSTEMD_SERVICE], {
          stdout: "inherit",
          stderr: "inherit",
        });
        await proc.exited;
        if (proc.exitCode === 0) {
          console.log("Clawster daemon started via systemctl.");
        } else {
          console.error(`Failed to start. Check: systemctl --user status ${SYSTEMD_SERVICE}`);
        }
      } else {
        console.log("No daemon installed. Run 'clawster daemon install' or use 'clawster start --foreground'.");
      }
    } else {
      console.log(`Daemon not supported on ${platform()}. Use 'clawster start --foreground'.`);
    }
  });
