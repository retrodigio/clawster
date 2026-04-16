import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

const TMP = mkdtempSync(join(tmpdir(), "clawster-sessions-"));
process.env.CLAWSTER_HOME = TMP;

// Import AFTER setting CLAWSTER_HOME so getClawsterHome resolves to the tmp dir.
const { getSession, saveSession, clearSession, getAllSessions, getSessionKey } = await import(
  "../src/core/session-store.ts"
);

const sessionsDir = join(TMP, "sessions");

beforeAll(() => {
  mkdirSync(sessionsDir, { recursive: true });
});

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear between tests
  try {
    rmSync(sessionsDir, { recursive: true, force: true });
  } catch { /* ignore */ }
  mkdirSync(sessionsDir, { recursive: true });
});

describe("session-store", () => {
  test("returns a default session when none exists", async () => {
    const s = await getSession("newagent");
    expect(s.sessionId).toBeNull();
    expect(s.messageCount).toBe(0);
    expect(s.lastHeartbeat).toBeNull();
    expect(typeof s.lastActivity).toBe("string");
  });

  test("save and read round-trip", async () => {
    await saveSession("zero", {
      sessionId: "abc-123",
      lastActivity: "2026-04-16T00:00:00.000Z",
      lastHeartbeat: "2026-04-16T00:00:00.000Z",
      messageCount: 42,
    });

    const s = await getSession("zero");
    expect(s.sessionId).toBe("abc-123");
    expect(s.messageCount).toBe(42);
  });

  test("save/get with topicId uses a distinct file", async () => {
    await saveSession("zero", {
      sessionId: "main",
      lastActivity: "t",
      lastHeartbeat: null,
      messageCount: 1,
    });
    await saveSession(
      "zero",
      { sessionId: "topic11", lastActivity: "t", lastHeartbeat: null, messageCount: 7 },
      11,
    );

    expect((await getSession("zero")).sessionId).toBe("main");
    expect((await getSession("zero", 11)).sessionId).toBe("topic11");
  });

  test("recovers from .tmp when the main file is corrupt", async () => {
    const mainPath = join(sessionsDir, "zero.json");
    const tmpPath = `${mainPath}.tmp`;

    // Corrupt main file + good .tmp file → recovery path
    writeFileSync(mainPath, "{ not json");
    writeFileSync(
      tmpPath,
      JSON.stringify({
        sessionId: "recovered",
        lastActivity: "t",
        lastHeartbeat: null,
        messageCount: 3,
      }),
    );

    const s = await getSession("zero");
    expect(s.sessionId).toBe("recovered");
  });

  test("returns default when both main and .tmp are corrupt", async () => {
    const mainPath = join(sessionsDir, "zero.json");
    const tmpPath = `${mainPath}.tmp`;
    writeFileSync(mainPath, "{{{");
    writeFileSync(tmpPath, "}}}");

    const s = await getSession("zero");
    expect(s.sessionId).toBeNull();
  });

  test("clearSession removes the file", async () => {
    await saveSession("zero", {
      sessionId: "x",
      lastActivity: "t",
      lastHeartbeat: null,
      messageCount: 0,
    });
    await clearSession("zero");
    const s = await getSession("zero");
    expect(s.sessionId).toBeNull();
  });

  test("getAllSessions returns every saved key (no .tmp entries)", async () => {
    await saveSession("a", { sessionId: "A", lastActivity: "t", lastHeartbeat: null, messageCount: 0 });
    await saveSession("b", { sessionId: "B", lastActivity: "t", lastHeartbeat: null, messageCount: 0 });
    await saveSession(
      "b",
      { sessionId: "B-11", lastActivity: "t", lastHeartbeat: null, messageCount: 0 },
      11,
    );

    const all = await getAllSessions();
    expect(all.get("a")?.sessionId).toBe("A");
    expect(all.get("b")?.sessionId).toBe("B");
    expect(all.get("b-topic-11")?.sessionId).toBe("B-11");
  });

  test("getSessionKey formats topic-keyed sessions", () => {
    expect(getSessionKey("zero")).toBe("zero");
    expect(getSessionKey("zero", 11)).toBe("zero-topic-11");
  });
});
