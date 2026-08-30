import { describe, expect, test } from "bun:test";
import {
  buildRecoveryManifest,
  classify,
  decide,
  DEFAULT_SUPERVISOR_CONFIG,
  initialState,
  type PluginHealth,
  type SessionObservation,
  type SupervisorConfig,
  type SupervisorState,
} from "../src/core/supervisor.ts";

const T0 = 1_700_000_000_000;
const cfg: SupervisorConfig = { ...DEFAULT_SUPERVISOR_CONFIG };

function alive(over: Partial<SessionObservation> = {}): SessionObservation {
  return { alive: true, pid: 1234, sessionId: "abcd1234-ef", status: "idle", ...over };
}

/** Delivered an event, nothing came back, long enough ago to be a real stall. */
function stalled(now = T0): PluginHealth {
  return {
    updatedAt: now,
    lastEventDeliveredAt: now - cfg.wedgeTimeoutMs - 1_000,
    lastToolCallAt: now - cfg.wedgeTimeoutMs - 5_000,
    pendingEvents: 1,
  };
}

describe("classify", () => {
  test("a dead process is dead", () => {
    expect(classify(T0, { alive: false }, undefined, cfg)).toBe("dead");
  });

  test("no plugin health means we assume working, never wedged", () => {
    // status alone cannot distinguish a 20-minute subagent from a stuck session.
    expect(classify(T0, alive({ status: "busy" }), undefined, cfg)).toBe("working");
  });

  test("stale plugin health is not evidence of a wedge", () => {
    const health = { ...stalled(T0), updatedAt: T0 - cfg.healthStaleMs - 1 };
    expect(classify(T0, alive(), health, cfg)).toBe("working");
  });

  test("an answered event is working, however long it took", () => {
    const h: PluginHealth = {
      updatedAt: T0,
      lastEventDeliveredAt: T0 - 600_000,
      lastToolCallAt: T0 - 599_000,
    };
    expect(classify(T0, alive(), h, cfg)).toBe("working");
  });

  test("delivered but unanswered inside the timeout is still working", () => {
    const h: PluginHealth = {
      updatedAt: T0,
      lastEventDeliveredAt: T0 - 10_000,
      lastToolCallAt: T0 - 20_000,
    };
    expect(classify(T0, alive(), h, cfg)).toBe("working");
  });

  test("delivered, unanswered, past the timeout is wedged", () => {
    expect(classify(T0, alive(), stalled(T0), cfg)).toBe("wedged");
  });

  test("no event ever delivered cannot be a wedge", () => {
    expect(classify(T0, alive(), { updatedAt: T0 }, cfg)).toBe("working");
  });
});

describe("decide — healthy and dead paths", () => {
  test("working does nothing", () => {
    const { action } = decide({ now: T0, session: alive(), state: initialState(), config: cfg });
    expect(action.kind).toBe("none");
  });

  test("a dead orchestrator starts immediately, with no wedge confirmation", () => {
    const { action, state } = decide({
      now: T0, session: { alive: false }, state: initialState(), config: cfg,
    });
    expect(action.kind).toBe("start");
    expect(state.restartTimes).toHaveLength(1);
  });
});

describe("decide — wedge requires confirmation, then a probe", () => {
  test("first wedge reading only waits", () => {
    const r = decide({ now: T0, session: alive(), health: stalled(), state: initialState(), config: cfg });
    expect(r.action.kind).toBe("none");
    expect(r.state.consecutiveWedgeReadings).toBe(1);
  });

  test("second reading probes rather than restarting", () => {
    let s = initialState();
    s = decide({ now: T0, session: alive(), health: stalled(), state: s, config: cfg }).state;
    const r = decide({ now: T0 + 1000, session: alive(), health: stalled(T0 + 1000), state: s, config: cfg });
    // A session that answers the probe was never wedged, and a false-positive
    // restart costs every live thread.
    expect(r.action.kind).toBe("probe");
    expect(r.state.restartTimes).toHaveLength(0);
  });

  test("a third reading, after the probe failed to clear it, restarts", () => {
    let s = initialState();
    for (const n of [T0, T0 + 1000]) {
      s = decide({ now: n, session: alive(), health: stalled(n), state: s, config: cfg }).state;
    }
    const r = decide({ now: T0 + 2000, session: alive(), health: stalled(T0 + 2000), state: s, config: cfg });
    expect(r.action.kind).toBe("restart");
  });

  test("recovery resets the wedge counter", () => {
    let s = initialState();
    s = decide({ now: T0, session: alive(), health: stalled(), state: s, config: cfg }).state;
    expect(s.consecutiveWedgeReadings).toBe(1);
    s = decide({ now: T0 + 1000, session: alive(), state: s, config: cfg }).state;
    expect(s.consecutiveWedgeReadings).toBe(0);
  });
});

describe("decide — backoff and circuit breaker", () => {
  function forceRestart(state: SupervisorState, now: number) {
    return decide({ now, session: { alive: false }, state, config: cfg });
  }

  test("backoff blocks a second restart until the ladder allows it", () => {
    let s = initialState();
    s = forceRestart(s, T0).state;
    const r = forceRestart(s, T0 + 1000);
    expect(r.action.kind).toBe("none");
    expect(r.action.reason).toContain("backoff");
  });

  test("backoff lengthens across attempts", () => {
    let s = initialState();
    s = forceRestart(s, T0).state;
    const first = s.nextRestartAllowedAt - T0;
    const t1 = s.nextRestartAllowedAt;
    s = forceRestart(s, t1).state;
    const second = s.nextRestartAllowedAt - t1;
    expect(second).toBeGreaterThan(first);
  });

  test("breaker trips after maxRestarts inside the window and then latches", () => {
    let s = initialState();
    let now = T0;
    for (let i = 0; i < cfg.maxRestarts; i++) {
      const r = forceRestart(s, now);
      s = r.state;
      now = s.nextRestartAllowedAt;
    }
    const tripped = forceRestart(s, now);
    expect(tripped.action.kind).toBe("circuit-open");
    expect(tripped.state.circuitOpen).toBe(true);

    // Latches: even a healthy-looking tick stays open until an operator clears it.
    const after = decide({ now: now + 10_000, session: alive(), state: tripped.state, config: cfg });
    expect(after.action.kind).toBe("circuit-open");
  });

  test("restarts outside the window do not count toward the breaker", () => {
    let s = initialState();
    s = forceRestart(s, T0).state;
    const later = T0 + cfg.circuitWindowMs + 1;
    const r = forceRestart(s, later);
    expect(r.action.kind).toBe("start");
    expect(r.state.restartTimes).toHaveLength(1);
    expect(r.state.circuitOpen).toBe(false);
  });
});

describe("buildRecoveryManifest", () => {
  test("records the paths a successor needs to find orphaned subagents", () => {
    const m = buildRecoveryManifest({
      now: T0,
      reason: "wedged",
      session: alive({ sessionId: "28f82c80-a364-4674-8543-5308fe389e7c", pid: 99 }),
      projectHash: "-Users-chris-orch",
      liveThreadIds: ["-100:11", "-100:7"],
      home: "/Users/chris",
    });
    expect(m.subagentsPath).toBe(
      "/Users/chris/.claude/projects/-Users-chris-orch/28f82c80-a364-4674-8543-5308fe389e7c/subagents",
    );
    // Teams state is keyed by the FIRST 8 chars of the session uuid.
    expect(m.teamsConfigPath).toBe("/Users/chris/.claude/teams/session-28f82c80/config.json");
    expect(m.liveThreadIds).toHaveLength(2);
    expect(m.pid).toBe(99);
  });

  test("omits derived paths when the session id is unknown", () => {
    const m = buildRecoveryManifest({
      now: T0, reason: "dead", session: { alive: false },
      liveThreadIds: [], home: "/Users/chris",
    });
    expect(m.subagentsPath).toBeUndefined();
    expect(m.teamsConfigPath).toBeUndefined();
  });
});

describe("orchestrator spawn — chrome flag", () => {
  async function spawnCmd(
    chrome: boolean,
    over: { model?: string; effort?: string } = {},
  ): Promise<string[]> {
    const { OrchestratorSupervisor, defaultOptions } = await import(
      "../src/core/orchestrator-supervisor.ts"
    );
    let captured: string[] = [];
    const sup = new OrchestratorSupervisor({
      ...defaultOptions(),
      chrome,
      ...over,
      exec: async (cmd: string[]) => {
        if (cmd[1] === "new-session") captured = cmd;
        return { code: 0, stdout: "" };
      },
    });
    await sup.startOrchestrator(1);
    return captured;
  }

  test("chrome:true puts --chrome on the claude command", async () => {
    // The supervisor owns the session's lifecycle, so a hand-started
    // `claude --chrome` is replaced by this command on the next restart.
    // If the flag is not here, browser tools vanish mid-thread with no error.
    const cmd = await spawnCmd(true);
    expect(cmd.at(-1)).toContain("--chrome");
    expect(cmd.at(-1)).toContain("--dangerously-load-development-channels");
  });

  test("chrome:false omits it without mangling the rest", async () => {
    const cmd = await spawnCmd(false, { model: "", effort: "" });
    expect(cmd.at(-1)).not.toContain("--chrome");
    expect(cmd.at(-1)).toStartWith("claude --dangerously-load-development-channels");
  });
});

describe("orchestrator spawn — model and effort", () => {
  async function cmd(over: { model?: string; effort?: string }): Promise<string> {
    const { OrchestratorSupervisor, defaultOptions } = await import(
      "../src/core/orchestrator-supervisor.ts"
    );
    let captured: string[] = [];
    const sup = new OrchestratorSupervisor({
      ...defaultOptions(),
      ...over,
      exec: async (c: string[]) => {
        if (c[1] === "new-session") captured = c;
        return { code: 0, stdout: "" };
      },
    });
    await sup.startOrchestrator(1);
    return captured.at(-1) ?? "";
  }

  test("defaults pin the session to sonnet at low effort", async () => {
    // Routing is a lookup, not reasoning. Left unpinned the session inherits
    // the operator's personal ~/.claude/settings.json, which measured 9-63s
    // per dispatch at opus/high.
    const c = await cmd({});
    expect(c).toContain("--model sonnet");
    expect(c).toContain("--effort low");
  });

  test("empty strings mean inherit, not an empty flag", async () => {
    // A bare `--model` with no value would make claude refuse to start, which
    // the supervisor would then see as a session that will not come up.
    const c = await cmd({ model: "", effort: "" });
    expect(c).not.toContain("--model");
    expect(c).not.toContain("--effort");
    expect(c).toContain("--dangerously-load-development-channels");
  });

  test("flags precede the channel arg so they are not swallowed by it", async () => {
    const c = await cmd({ model: "opus", effort: "high" });
    expect(c.indexOf("--model")).toBeLessThan(c.indexOf("--dangerously-load"));
    expect(c).toStartWith("claude --model opus --effort high");
  });
});
