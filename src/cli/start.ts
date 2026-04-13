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
