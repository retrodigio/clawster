import { Command } from "commander";
import { readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

export const stopCommand = new Command("stop")
  .description("Stop the Clawster orchestrator")
  .action(async () => {
    const home = getClawsterHome();
    const lockFile = join(home, "clawster.lock");
    let stopped = false;

    // Try PID-based stop
    if (existsSync(lockFile)) {
      try {
        const pidStr = await readFile(lockFile, "utf-8");
        const pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          try {
            process.kill(pid, "SIGTERM");
            console.log(`Sent SIGTERM to process ${pid}.`);
            stopped = true;
          } catch {
            console.log(`Process ${pid} is not running.`);
          }
        }
        await unlink(lockFile);
      } catch {
        // Lock file unreadable or already gone
      }
    }

    // Platform-specific daemon stop
    if (platform() === "darwin" && existsSync(PLIST_PATH)) {
      const uid = process.getuid?.() ?? 501;
      const proc = Bun.spawn(["launchctl", "bootout", `gui/${uid}/${LABEL}`], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      if (proc.exitCode === 0) {
        console.log("Daemon unloaded via launchctl.");
        stopped = true;
      }
    } else if (platform() === "linux") {
      const proc = Bun.spawn(["systemctl", "--user", "stop", SYSTEMD_SERVICE], {
        stdout: "inherit",
        stderr: "inherit",
      });
      await proc.exited;
      if (proc.exitCode === 0) {
        console.log("Daemon stopped via systemctl.");
        stopped = true;
      }
    }

    if (!stopped) {
      console.log("No running Clawster instance found.");
    }
  });
