import { Command } from "commander";
import { readFile, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir, platform } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

const PLIST_PATH = join(homedir(), "Library", "LaunchAgents", "com.clawster.daemon.plist");
const LABEL = "com.clawster.daemon";
const SYSTEMD_SERVICE = "clawster.service";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function readLockPid(lockFile: string): Promise<number | null> {
  try {
    const pidStr = await readFile(lockFile, "utf-8");
    const pid = parseInt(pidStr.trim(), 10);
    return isNaN(pid) ? null : pid;
  } catch {
    return null;
  }
}

/**
 * Wait for the orchestrator to finish its graceful shutdown (it releases the
 * lock file as the last step, after draining in-flight queries for up to 30s).
 * This makes `clawster stop && clawster start` safe — without it, start would
 * race the old instance and lose the lock.
 */
async function waitForShutdown(lockFile: string, timeoutMs = 35_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    if (!existsSync(lockFile)) return true;
    const pid = await readLockPid(lockFile);
    if (pid === null || !isPidAlive(pid)) {
      // Process died without releasing the lock — clean up the stale file.
      await unlink(lockFile).catch(() => {});
      return true;
    }
    if (!announced) {
      console.log("Waiting for in-flight work to finish (up to 30s)...");
      announced = true;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

export const stopCommand = new Command("stop")
  .description("Stop the Clawster orchestrator")
  .action(async () => {
    const home = getClawsterHome();
    const lockFile = join(home, "clawster.lock");
    let stopped = false;

    if (platform() === "darwin" && existsSync(PLIST_PATH)) {
      // launchd manages the process — bootout is the whole story. It delivers
      // SIGTERM and deregisters the service so KeepAlive can't respawn it.
      // Killing the PID directly first would just trigger a KeepAlive respawn.
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

    // Fallback for foreground / unmanaged instances: signal the PID from the
    // lock file. The process releases its own lock during graceful shutdown —
    // never delete the lock of a live process.
    if (!stopped && existsSync(lockFile)) {
      const pid = await readLockPid(lockFile);
      if (pid !== null && isPidAlive(pid)) {
        try {
          process.kill(pid, "SIGTERM");
          console.log(`Sent SIGTERM to process ${pid}.`);
          stopped = true;
        } catch {
          console.log(`Could not signal process ${pid}.`);
        }
      } else {
        // Stale lock — no live process behind it.
        await unlink(lockFile).catch(() => {});
      }
    }

    if (!stopped) {
      console.log("No running Clawster instance found.");
      return;
    }

    const clean = await waitForShutdown(lockFile);
    if (clean) {
      console.log("Clawster stopped.");
    } else {
      console.warn("Shutdown is taking longer than expected — check 'clawster status' before restarting.");
    }
  });
