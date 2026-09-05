/**
 * Reap SDK child processes orphaned by a previous daemon death.
 *
 * The agent runner spawns one `claude` binary per run, out of this install's
 * `node_modules/@anthropic-ai/claude-agent-sdk*`. Those children are reaped by
 * the daemon on a graceful shutdown, but a hard death — SIGKILL, a launchd
 * crash-restart, an OOM — leaves them behind. They reparent to PID 1, where
 * nothing will ever reap them, and at least one observed failure mode is a
 * tight spin loop that burns a full core indefinitely and ignores SIGTERM.
 *
 * The identification rule is `PPID === 1` plus an executable path inside this
 * install. That is sound only because the sweep runs *after* `acquireLock()`:
 * the lock guarantees no other live daemon of this install, and we have not
 * spawned anything yet, so a live daemon's children (which carry that daemon's
 * pid as PPID, never 1) cannot be in the match set. Calling this at any other
 * point would kill in-flight work.
 */
import { resolve } from "path";
import { log } from "./logger.ts";

/** Everything this install spawns lives under here. */
const SDK_PREFIX = resolve(
  import.meta.dir,
  "../../node_modules/@anthropic-ai/claude-agent-sdk",
);

/** Grace period between SIGTERM and SIGKILL. */
const TERM_GRACE_MS = 2_000;

export interface OrphanProc {
  pid: number;
  command: string;
}

export interface SweepDeps {
  /** Returns `pid ppid command` lines, one process per line. */
  listProcesses: () => Promise<string>;
  /** Signal `0` is a liveness probe: it throws when the pid is gone. */
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  sleep: (ms: number) => Promise<void>;
  /** Path prefix that marks a process as ours. */
  prefix?: string;
  /** Never target ourselves, whatever the ps output says. */
  selfPid?: number;
}

async function psLines(): Promise<string> {
  const proc = Bun.spawn(["ps", "-eo", "pid=,ppid=,command="], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(proc.stdout).text();
  await proc.exited;
  return out;
}

export function defaultSweepDeps(): SweepDeps {
  return {
    listProcesses: psLines,
    kill: (pid, signal) => process.kill(pid, signal),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

/**
 * Parse `ps -eo pid=,ppid=,command=` output down to the orphans we own.
 * Exported for testing — the parsing, not the killing, is where bugs hide.
 */
export function findOrphans(
  psOutput: string,
  prefix: string,
  selfPid: number,
): OrphanProc[] {
  const found: OrphanProc[] = [];
  for (const line of psOutput.split("\n")) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
    if (!m) continue;
    const pid = Number(m[1]);
    const ppid = Number(m[2]);
    const command = (m[3] ?? "").trim();
    if (ppid !== 1) continue;
    if (pid === selfPid) continue;
    if (!command.startsWith(prefix)) continue;
    found.push({ pid, command });
  }
  return found;
}

/**
 * Kill SDK children left behind by a previous daemon. Returns the pids reaped.
 *
 * A sweep failure is never allowed to block startup: the daemon coming up
 * matters more than a stray process going down, so every error is logged and
 * swallowed.
 */
export async function sweepOrphanedSdkProcesses(
  deps: SweepDeps = defaultSweepDeps(),
): Promise<number[]> {
  const prefix = deps.prefix ?? SDK_PREFIX;
  const selfPid = deps.selfPid ?? process.pid;

  let orphans: OrphanProc[];
  try {
    orphans = findOrphans(await deps.listProcesses(), prefix, selfPid);
  } catch (err) {
    log.error("orphan-sweep", "Could not list processes", { error: String(err) });
    return [];
  }

  if (orphans.length === 0) return [];

  log.info("orphan-sweep", "Found orphaned SDK processes from a previous run", {
    count: orphans.length,
    pids: orphans.map((o) => o.pid),
  });

  const termed: number[] = [];
  for (const o of orphans) {
    try {
      deps.kill(o.pid, "SIGTERM");
      termed.push(o.pid);
    } catch {
      // Already gone between ps and kill — the outcome we wanted anyway.
    }
  }
  if (termed.length === 0) return [];

  // A spinning process never services SIGTERM, so escalate rather than leave
  // the core burning.
  await deps.sleep(TERM_GRACE_MS);

  const stubborn: number[] = [];
  for (const pid of termed) {
    try {
      deps.kill(pid, 0);
    } catch {
      continue; // SIGTERM was enough.
    }
    try {
      deps.kill(pid, "SIGKILL");
      stubborn.push(pid);
    } catch {
      // Raced us to exit.
    }
  }

  log.info("orphan-sweep", "Reaped orphaned SDK processes", {
    pids: termed,
    neededSigkill: stubborn,
  });
  return termed;
}
