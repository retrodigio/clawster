import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createAgentRunner } from "../src/core/agent-runner.ts";
import { saveSession } from "../src/core/session-store.ts";
import type { AgentConfig } from "../src/core/types.ts";

/**
 * Mock-SDK harness: drives runStreaming with scripted message sequences
 * instead of a real claude subprocess. Covers the paths that have actually
 * had incidents — stale-session self-heal, stall retry — which previously
 * had zero automated coverage.
 */

let home: string;
let prevHome: string | undefined;

beforeEach(async () => {
  prevHome = process.env.CLAWSTER_HOME;
  home = await mkdtemp(join(tmpdir(), "clawster-runner-"));
  process.env.CLAWSTER_HOME = home;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.CLAWSTER_HOME;
  else process.env.CLAWSTER_HOME = prevHome;
  await rm(home, { recursive: true, force: true });
});

const agent: AgentConfig = {
  id: "tester",
  name: "Tester",
  workspace: "/tmp",
  telegramChatId: "",
  // 50ms inactivity window so stall tests run fast (value is in seconds).
  inactivityTimeout: 0.05,
};

const init = (sessionId: string) => ({ type: "system", subtype: "init", session_id: sessionId });
const result = (text: string, sessionId: string) => ({ type: "result", result: text, session_id: sessionId });

interface Behavior {
  /** Messages to yield in order. */
  messages?: any[];
  /** Throw after yielding messages (e.g. stale-session error). */
  throwError?: Error;
  /** After yielding messages, hang until the abort signal fires, then throw. */
  hang?: boolean;
}

/** queryFn that replays one Behavior per call and records every call's options. */
function fakeQuery(behaviors: Behavior[]) {
  const calls: Array<{ prompt: string; options: any }> = [];
  const fn = (({ prompt, options }: { prompt: string; options: any }) => {
    calls.push({ prompt, options });
    const behavior = behaviors[Math.min(calls.length - 1, behaviors.length - 1)]!;
    return {
      async *[Symbol.asyncIterator]() {
        for (const m of behavior.messages ?? []) yield m;
        if (behavior.throwError) throw behavior.throwError;
        if (behavior.hang) {
          await new Promise((_, reject) => {
            const signal: AbortSignal | undefined = options.abortController?.signal;
            if (!signal) return; // hang forever (test would time out — signal is always set)
            if (signal.aborted) return reject(new Error("aborted by user"));
            signal.addEventListener("abort", () => reject(new Error("aborted by user")));
          });
        }
      },
      interrupt: async () => {},
      close: () => {},
    } as any;
  }) as ((args: { prompt: string; options: any }) => any) & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

function makeRunner(queryFn: any) {
  return createAgentRunner({ maxConcurrent: 2, mcpConfigPath: "", queryFn });
}

async function readSessionFile(name: string): Promise<any> {
  return JSON.parse(await readFile(join(home, "sessions", `${name}.json`), "utf-8"));
}

describe("runStreaming (mock SDK)", () => {
  test("happy path: returns result text and persists the session", async () => {
    const q = fakeQuery([{ messages: [init("s1"), result("hello there", "s1")] }]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "hi", () => {});

    expect(out.text).toBe("hello there");
    expect(out.sessionId).toBe("s1");
    expect(q.calls.length).toBe(1);
    expect(q.calls[0]!.options.resume).toBeUndefined();

    const session = await readSessionFile("tester");
    expect(session.sessionId).toBe("s1");
    expect(session.messageCount).toBe(1);
  });

  test("resumes a saved session and forks it", async () => {
    await saveSession("tester", {
      sessionId: "saved-123",
      lastActivity: new Date().toISOString(),
      lastHeartbeat: null,
      messageCount: 3,
    });
    const q = fakeQuery([{ messages: [init("saved-124"), result("resumed", "saved-124")] }]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "hi again", () => {});

    expect(out.text).toBe("resumed");
    expect(q.calls[0]!.options.resume).toBe("saved-123");
    expect(q.calls[0]!.options.forkSession).toBe(true);
  });

  test("self-heals a stale session: clears the dead pointer and retries fresh", async () => {
    await saveSession("tester", {
      sessionId: "dead-session",
      lastActivity: new Date().toISOString(),
      lastHeartbeat: null,
      messageCount: 5,
    });
    const q = fakeQuery([
      { throwError: new Error("No conversation found with session ID: dead-session") },
      { messages: [init("fresh-1"), result("recovered reply", "fresh-1")] },
    ]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "are you there?", () => {});

    expect(out.text).toBe("recovered reply");
    expect(q.calls.length).toBe(2);
    // First attempt resumed the dead session; the retry started clean.
    expect(q.calls[0]!.options.resume).toBe("dead-session");
    expect(q.calls[1]!.options.resume).toBeUndefined();

    const session = await readSessionFile("tester");
    expect(session.sessionId).toBe("fresh-1");
  });

  test("retries once after an inactivity stall and recovers", async () => {
    const q = fakeQuery([
      { messages: [init("s1")], hang: true },
      { messages: [init("s2"), result("after retry", "s2")] },
    ]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "slow one", () => {});

    expect(out.text).toBe("after retry");
    expect(q.calls.length).toBe(2);
    // The retry resumed the session saved during the stalled attempt.
    expect(q.calls[1]!.options.resume).toBe("s1");
  });

  test("reports unresponsiveness when both attempts stall", async () => {
    const q = fakeQuery([{ messages: [init("s1")], hang: true }]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "hopeless", () => {});

    expect(out.text).toContain("became unresponsive");
    expect(q.calls.length).toBe(2);
  });

  test("non-timeout errors propagate", async () => {
    const q = fakeQuery([{ throwError: new Error("kaboom") }]);
    const runner = makeRunner(q);

    await expect(runner.runStreaming(agent, "boom", () => {})).rejects.toThrow("kaboom");
  });

  test("run() shares the streaming path (self-heal works for heartbeats)", async () => {
    await saveSession("tester", {
      sessionId: "dead-hb",
      lastActivity: new Date().toISOString(),
      lastHeartbeat: null,
      messageCount: 1,
    }, undefined, "scheduled");
    const q = fakeQuery([
      { throwError: new Error("No conversation found with session ID: dead-hb") },
      { messages: [init("hb-2"), result("NO_CHECKIN", "hb-2")] },
    ]);
    const runner = makeRunner(q);

    const text = await runner.run(agent, "heartbeat check", { sessionScope: "scheduled" });

    expect(text).toBe("NO_CHECKIN");
    expect(q.calls.length).toBe(2);
  });

  test("sessionScope keeps scheduled runs out of the user session", async () => {
    await saveSession("tester", {
      sessionId: "user-session",
      lastActivity: new Date().toISOString(),
      lastHeartbeat: null,
      messageCount: 7,
    });
    const q = fakeQuery([{ messages: [init("hb-1"), result("NO_CHECKIN", "hb-1")] }]);
    const runner = makeRunner(q);

    await runner.run(agent, "heartbeat", { sessionScope: "scheduled" });

    // Scheduled run never saw — and never overwrote — the user's session.
    expect(q.calls[0]!.options.resume).toBeUndefined();
    const userSession = await readSessionFile("tester");
    expect(userSession.sessionId).toBe("user-session");
    expect(userSession.messageCount).toBe(7);
    const scheduledSession = await readSessionFile("tester-scheduled");
    expect(scheduledSession.sessionId).toBe("hb-1");
  });

  test("streams text deltas to onUpdate", async () => {
    const delta = (text: string) => ({
      type: "stream_event",
      event: { type: "content_block_delta", delta: { type: "text_delta", text } },
    });
    const q = fakeQuery([
      { messages: [init("s1"), delta("partial "), delta("answer"), result("partial answer", "s1")] },
    ]);
    const runner = makeRunner(q);

    const out = await runner.runStreaming(agent, "stream it", () => {});
    expect(out.text).toBe("partial answer");
  });

  test("uses the built-in default model when no resolveModel is provided", async () => {
    const q = fakeQuery([{ messages: [init("s1"), result("ok", "s1")] }]);
    const runner = makeRunner(q);
    await runner.runStreaming(agent, "hi", () => {});
    expect(q.calls[0]!.options.model).toBe("claude-opus-4-8");
  });

  test("threads resolveModel's return value into the query options", async () => {
    const q = fakeQuery([{ messages: [init("s1"), result("ok", "s1")] }]);
    const seen: Array<{ agentId: string; topicId?: number }> = [];
    const runner = createAgentRunner({
      maxConcurrent: 2,
      mcpConfigPath: "",
      queryFn: q,
      resolveModel: (a, topicId) => {
        seen.push({ agentId: a.id, topicId });
        return "fable";
      },
    });
    await runner.runStreaming(agent, "plan this", () => {}, { topicId: 7 });
    expect(q.calls[0]!.options.model).toBe("fable");
    expect(seen).toEqual([{ agentId: "tester", topicId: 7 }]);
  });

  test("resolves the model once and reuses it across a stall retry", async () => {
    const q = fakeQuery([
      { messages: [init("s1")], hang: true },       // attempt 1 stalls
      { messages: [init("s1"), result("done", "s1")] }, // attempt 2 succeeds
    ]);
    let calls = 0;
    const runner = createAgentRunner({
      maxConcurrent: 2,
      mcpConfigPath: "",
      queryFn: q,
      resolveModel: () => `sonnet-${++calls}`,
    });
    const out = await runner.runStreaming(agent, "slow", () => {});
    expect(out.text).toBe("done");
    expect(calls).toBe(1); // resolved once, not per attempt
    expect(q.calls[0]!.options.model).toBe("sonnet-1");
    expect(q.calls[1]!.options.model).toBe("sonnet-1");
  });
});
