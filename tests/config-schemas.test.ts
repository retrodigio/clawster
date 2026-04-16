import { describe, expect, test } from "bun:test";
import {
  AgentSchema,
  AgentsConfigSchema,
  ClawsterConfigSchema,
  HeartbeatSchema,
  TaskSchema,
} from "../src/core/config.ts";

describe("ClawsterConfigSchema", () => {
  test("accepts a minimal valid config and applies defaults", () => {
    const parsed = ClawsterConfigSchema.parse({
      botToken: "abc",
      allowedUserId: "123",
    });
    expect(parsed.claudePath).toBe("claude");
    expect(parsed.healthPort).toBe(18800);
    expect(parsed.maxConcurrent).toBe(4);
    expect(typeof parsed.timezone).toBe("string");
  });

  test("rejects missing botToken", () => {
    expect(() => ClawsterConfigSchema.parse({ allowedUserId: "123" })).toThrow();
  });

  test("rejects out-of-range healthPort", () => {
    expect(() =>
      ClawsterConfigSchema.parse({
        botToken: "abc",
        allowedUserId: "123",
        healthPort: 80,
      }),
    ).toThrow();
    expect(() =>
      ClawsterConfigSchema.parse({
        botToken: "abc",
        allowedUserId: "123",
        healthPort: 99999,
      }),
    ).toThrow();
  });

  test("rejects out-of-range maxConcurrent", () => {
    expect(() =>
      ClawsterConfigSchema.parse({
        botToken: "abc",
        allowedUserId: "123",
        maxConcurrent: 0,
      }),
    ).toThrow();
    expect(() =>
      ClawsterConfigSchema.parse({
        botToken: "abc",
        allowedUserId: "123",
        maxConcurrent: 100,
      }),
    ).toThrow();
  });
});

describe("HeartbeatSchema", () => {
  test("accepts 30m and 1h", () => {
    expect(HeartbeatSchema.parse({ every: "30m", target: "telegram", to: "-100" })).toBeTruthy();
    expect(HeartbeatSchema.parse({ every: "1h", target: "telegram", to: "-100" })).toBeTruthy();
  });

  test("rejects malformed interval", () => {
    expect(() => HeartbeatSchema.parse({ every: "30min", target: "telegram", to: "-100" })).toThrow();
    expect(() => HeartbeatSchema.parse({ every: "soon", target: "telegram", to: "-100" })).toThrow();
  });

  test("accepts activeHours window", () => {
    const h = HeartbeatSchema.parse({
      every: "1h",
      activeHours: { start: "08:00", end: "22:00" },
      target: "telegram",
      to: "-100",
    });
    expect(h.activeHours?.start).toBe("08:00");
  });

  test("rejects malformed activeHours", () => {
    expect(() =>
      HeartbeatSchema.parse({
        every: "1h",
        activeHours: { start: "8am", end: "10pm" },
        target: "telegram",
        to: "-100",
      }),
    ).toThrow();
  });

  test("rejects non-telegram target", () => {
    expect(() => HeartbeatSchema.parse({ every: "1h", target: "slack", to: "x" })).toThrow();
  });
});

describe("TaskSchema", () => {
  test("accepts minimal task and defaults enabled=true", () => {
    const t = TaskSchema.parse({ name: "n", schedule: "0 9 * * *", prompt: "/ping" });
    expect(t.enabled).toBe(true);
  });

  test("rejects empty name/schedule/prompt", () => {
    expect(() => TaskSchema.parse({ name: "", schedule: "0 9 * * *", prompt: "/ping" })).toThrow();
    expect(() => TaskSchema.parse({ name: "n", schedule: "", prompt: "/ping" })).toThrow();
    expect(() => TaskSchema.parse({ name: "n", schedule: "0 9 * * *", prompt: "" })).toThrow();
  });
});

describe("AgentSchema", () => {
  const base = { id: "zero", name: "Zero", workspace: "/tmp/zero", telegramChatId: "-100" };

  test("accepts a minimal agent", () => {
    expect(AgentSchema.parse(base)).toBeTruthy();
  });

  test("rejects empty id or name or workspace", () => {
    expect(() => AgentSchema.parse({ ...base, id: "" })).toThrow();
    expect(() => AgentSchema.parse({ ...base, name: "" })).toThrow();
    expect(() => AgentSchema.parse({ ...base, workspace: "" })).toThrow();
  });

  test("accepts topics map with name entries", () => {
    const parsed = AgentSchema.parse({ ...base, topics: { "11": { name: "Issues" } } });
    expect(parsed.topics?.["11"]?.name).toBe("Issues");
  });

  test("accepts heartbeat and tasks when valid", () => {
    const parsed = AgentSchema.parse({
      ...base,
      heartbeat: { every: "30m", target: "telegram", to: "-100" },
      tasks: [{ name: "daily", schedule: "0 9 * * *", prompt: "/report" }],
    });
    expect(parsed.tasks).toHaveLength(1);
  });
});

describe("AgentsConfigSchema", () => {
  test("defaults unboundChatIds to []", () => {
    const parsed = AgentsConfigSchema.parse({ agents: [] });
    expect(parsed.unboundChatIds).toEqual([]);
  });

  test("accepts a full config", () => {
    const parsed = AgentsConfigSchema.parse({
      agents: [{ id: "zero", name: "Zero", workspace: "/tmp/zero", telegramChatId: "-100" }],
      unboundChatIds: ["-200", "-300"],
    });
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.unboundChatIds).toHaveLength(2);
  });
});
