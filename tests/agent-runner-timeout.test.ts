import { describe, expect, test } from "bun:test";
import { createToolAwareActivityTimeout } from "../src/core/agent-runner.ts";

/**
 * These tests exercise the tool-aware inactivity-timeout state machine in isolation.
 * We drive time via a fake `now()` + Bun's `setTimeout` scheduling cannot be faked
 * without fake-timers, so we instead use very short millisecond thresholds and
 * real waits. The simulated scenario is:
 *
 *   t=0:   tool_use arrives       -> toolsInFlight = 1
 *   t=5u:  (silence, 5 units)     -> must NOT time out because tool is in flight
 *   t=5u:  tool_result arrives    -> toolsInFlight = 0, inactivity reverts to short
 *   t=8u:  still silent (3u)      -> inactivity (short) should fire
 *
 * Using 1 unit = 40ms, short inactivity = 60ms, max = 10000ms. The tool-in-flight
 * window (200ms) far exceeds short inactivity (60ms) but is well under max (10s).
 */

function makeAssistantToolUse(id: string, name = "Bash") {
  return {
    type: "assistant",
    message: {
      content: [
        { type: "tool_use", id, name, input: {} },
      ],
    },
  };
}

function makeUserToolResult(id: string) {
  return {
    type: "user",
    message: {
      content: [
        { type: "tool_result", tool_use_id: id, content: "ok" },
      ],
    },
  };
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("createToolAwareActivityTimeout", () => {
  test("does not fire during long tool-in-flight silence; fires after post-tool idle", async () => {
    const events: Array<{ reason: string; toolsInFlight: number }> = [];
    const timer = createToolAwareActivityTimeout({
      inactivityMs: 60,
      maxMs: 10_000,
      onTimeout: (reason, info) => events.push({ reason, toolsInFlight: info.toolsInFlight }),
    });

    // t=0: tool starts. While it's in flight, the effective ceiling is maxMs (10s).
    timer.observe(makeAssistantToolUse("tool-1"));
    expect(timer.toolsInFlight).toBe(1);

    // Wait 200ms — well past the 60ms short inactivity — but tool is in flight so no timeout.
    await wait(200);
    expect(timer.timedOut).toBe(false);

    // Tool finishes. toolsInFlight back to 0; short inactivity now active.
    timer.observe(makeUserToolResult("tool-1"));
    expect(timer.toolsInFlight).toBe(0);

    // Wait 30ms — under short inactivity, still safe.
    await wait(30);
    expect(timer.timedOut).toBe(false);

    // Wait another 80ms — now we're >60ms past the tool_result without activity: fires.
    await wait(80);
    expect(timer.timedOut).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]!.reason).toBe("inactivity");
    expect(events[0]!.toolsInFlight).toBe(0);

    timer.clear();
  });

  test("tracks nested/multiple tool_use ids and only reverts when all close", async () => {
    const events: Array<{ reason: string; toolsInFlight: number }> = [];
    const timer = createToolAwareActivityTimeout({
      inactivityMs: 60,
      maxMs: 10_000,
      onTimeout: (reason, info) => events.push({ reason, toolsInFlight: info.toolsInFlight }),
    });

    timer.observe(makeAssistantToolUse("a"));
    timer.observe(makeAssistantToolUse("b"));
    expect(timer.toolsInFlight).toBe(2);

    // Finish one of two; still in tool-in-flight mode.
    timer.observe(makeUserToolResult("a"));
    expect(timer.toolsInFlight).toBe(1);

    await wait(200); // longer than short inactivity
    expect(timer.timedOut).toBe(false);

    // Finish the second. Now short inactivity window applies.
    timer.observe(makeUserToolResult("b"));
    expect(timer.toolsInFlight).toBe(0);

    await wait(120);
    expect(timer.timedOut).toBe(true);
    expect(events[0]!.toolsInFlight).toBe(0);

    timer.clear();
  });

  test("max ceiling still fires even while tool is in flight, reporting toolsInFlight > 0", async () => {
    const events: Array<{ reason: string; toolsInFlight: number }> = [];
    const timer = createToolAwareActivityTimeout({
      inactivityMs: 1_000, // high — don't let inactivity race us
      maxMs: 80,           // very short max ceiling
      onTimeout: (reason, info) => events.push({ reason, toolsInFlight: info.toolsInFlight }),
    });

    timer.observe(makeAssistantToolUse("slow-bash"));
    await wait(150);

    expect(timer.timedOut).toBe(true);
    expect(events.length).toBe(1);
    expect(events[0]!.reason).toBe("max");
    expect(events[0]!.toolsInFlight).toBe(1);

    timer.clear();
  });

  test("ignores duplicate tool_use ids (idempotent start)", () => {
    const timer = createToolAwareActivityTimeout({
      inactivityMs: 10_000,
      maxMs: 10_000,
      onTimeout: () => {},
    });
    timer.observe(makeAssistantToolUse("dup"));
    timer.observe(makeAssistantToolUse("dup"));
    expect(timer.toolsInFlight).toBe(1);
    timer.clear();
  });

  test("never drops below zero on spurious tool_result", () => {
    const timer = createToolAwareActivityTimeout({
      inactivityMs: 10_000,
      maxMs: 10_000,
      onTimeout: () => {},
    });
    timer.observe(makeUserToolResult("ghost"));
    expect(timer.toolsInFlight).toBe(0);
    timer.clear();
  });
});
