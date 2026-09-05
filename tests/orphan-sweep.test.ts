import { describe, expect, test } from "bun:test";
import {
  findOrphans,
  sweepOrphanedSdkProcesses,
  type SweepDeps,
} from "../src/core/orphan-sweep.ts";

const PREFIX = "/repo/node_modules/@anthropic-ai/claude-agent-sdk";
const SELF = 4242;

/** Shape of real `ps -eo pid=,ppid=,command=` output, leading spaces included. */
const PS = [
  `  33693     1 ${PREFIX}-darwin-x64/claude --output-format stream-json`,
  `  33694     1 ${PREFIX}/cli.js --resume abc`,
  `  33695  1234 ${PREFIX}-darwin-x64/claude --output-format stream-json`,
  "  33696     1 /usr/bin/node /some/other/thing.js",
  `  ${SELF}     1 ${PREFIX}-darwin-x64/claude --self`,
  "",
].join("\n");

describe("findOrphans", () => {
  test("matches only PID-1-parented processes under our install", () => {
    const found = findOrphans(PS, PREFIX, SELF);
    expect(found.map((o) => o.pid).sort()).toEqual([33693, 33694]);
  });

  test("spares children of a live parent", () => {
    // 33695 has PPID 1234 — a running daemon's in-flight work.
    expect(findOrphans(PS, PREFIX, SELF).some((o) => o.pid === 33695)).toBe(false);
  });

  test("spares unrelated processes and never targets self", () => {
    const pids = findOrphans(PS, PREFIX, SELF).map((o) => o.pid);
    expect(pids).not.toContain(33696);
    expect(pids).not.toContain(SELF);
  });

  test("does not match a different install sharing a path suffix", () => {
    const other = "  99  1 /elsewhere/node_modules/@anthropic-ai/claude-agent-sdk/claude";
    expect(findOrphans(other, PREFIX, SELF)).toEqual([]);
  });

  test("tolerates empty and malformed ps output", () => {
    expect(findOrphans("", PREFIX, SELF)).toEqual([]);
    expect(findOrphans("garbage\n\n  x y z", PREFIX, SELF)).toEqual([]);
  });
});

function deps(over: Partial<SweepDeps> = {}): SweepDeps & { calls: [number, string | 0][] } {
  const calls: [number, string | 0][] = [];
  return {
    listProcesses: async () => PS,
    kill: (pid, signal) => { calls.push([pid, signal]); },
    sleep: async () => {},
    prefix: PREFIX,
    selfPid: SELF,
    calls,
    ...over,
  };
}

describe("sweepOrphanedSdkProcesses", () => {
  test("SIGTERMs orphans, then SIGKILLs the ones still alive", async () => {
    const d = deps({
      // Signal 0 throws for 33694 (it died on SIGTERM) but not 33693.
      kill: (pid, signal) => {
        d.calls.push([pid, signal]);
        if (signal === 0 && pid === 33694) throw new Error("ESRCH");
      },
    });
    const reaped = await sweepOrphanedSdkProcesses(d);

    expect(reaped.sort()).toEqual([33693, 33694]);
    expect(d.calls).toContainEqual([33693, "SIGTERM"]);
    expect(d.calls).toContainEqual([33694, "SIGTERM"]);
    expect(d.calls).toContainEqual([33693, "SIGKILL"]);
    expect(d.calls).not.toContainEqual([33694, "SIGKILL"]);
  });

  test("does nothing when there are no orphans", async () => {
    const d = deps({ listProcesses: async () => "  1  0 /sbin/launchd\n" });
    expect(await sweepOrphanedSdkProcesses(d)).toEqual([]);
    expect(d.calls).toEqual([]);
  });

  test("a ps failure is swallowed so startup is never blocked", async () => {
    const d = deps({ listProcesses: async () => { throw new Error("ps exploded"); } });
    expect(await sweepOrphanedSdkProcesses(d)).toEqual([]);
  });

  test("a process that exits between ps and SIGTERM is not escalated", async () => {
    const d = deps({
      kill: (pid, signal) => {
        d.calls.push([pid, signal]);
        if (signal === "SIGTERM") throw new Error("ESRCH");
      },
    });
    expect(await sweepOrphanedSdkProcesses(d)).toEqual([]);
    expect(d.calls.some(([, s]) => s === "SIGKILL")).toBe(false);
  });
});
