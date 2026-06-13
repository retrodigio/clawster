import { join } from "path";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import { log } from "./logger.ts";
import { getClawsterHome } from "./config.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function acquireLock(): Promise<boolean> {
  const home = getClawsterHome();
  const lockFile = join(home, "clawster.lock");
  try {
    await mkdir(home, { recursive: true });

    try {
      const existing = await readFile(lockFile, "utf-8");
      const pid = parseInt(existing.trim(), 10);
      if (!isNaN(pid) && isPidAlive(pid)) {
        log.error("system", "Lock held by active process", { pid });
        return false;
      }
      log.info("system", "Removing stale lock", { stalePid: pid });
    } catch {
      // No existing lock file — proceed
    }

    await writeFile(lockFile, String(process.pid), "utf-8");

    // NOTE: no signal handlers here. The orchestrator's shutdown path in
    // server.ts owns SIGINT/SIGTERM and releases the lock after draining —
    // a second handler that exits early would skip the graceful drain.

    log.info("system", "Lock acquired", { pid: process.pid });
    return true;
  } catch (err) {
    log.error("system", "Failed to acquire lock", { error: String(err) });
    return false;
  }
}

export async function releaseLock(): Promise<void> {
  try {
    await unlink(join(getClawsterHome(), "clawster.lock"));
    log.info("system", "Lock released");
  } catch {
    // Lock file already removed — ignore
  }
}
