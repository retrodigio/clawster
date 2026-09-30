import { describe, expect, test } from "bun:test";
import {
  checkAgentTask,
  maxRunsPerDay,
  upsertTask,
  removeTask,
  describeTaskChange,
  MAX_RUNS_PER_DAY,
} from "../src/core/task-policy.ts";
import type { AgentConfig } from "../src/core/types.ts";

const agent = {
  id: "lettergnome",
  name: "LetterGnome",
  workspace: "/tmp/lg",
  telegramChatId: "-1001000000001",
} as AgentConfig;

const good = { name: "operator", schedule: "0 7-23/2 * * *", prompt: "do the thing", timeoutMs: 1_800_000 };

describe("maxRunsPerDay", () => {
  test("counts real schedules", () => {
    expect(maxRunsPerDay("0 7-23/2 * * *")).toBe(9); // 7,9,…,23
    expect(maxRunsPerDay("15 0 * * *")).toBe(1);
    expect(maxRunsPerDay("*/30 * * * *")).toBe(48);
    expect(maxRunsPerDay("* * * * *")).toBe(1440);
  });

  test("takes the busiest day, not the average", () => {
    // Every 10 minutes, Mondays only.
    expect(maxRunsPerDay("*/10 * * * 1")).toBe(144);
  });
});

describe("checkAgentTask", () => {
  test("accepts LetterGnome's real tasks", () => {
    expect(checkAgentTask(agent, good).ok).toBe(true);
    expect(checkAgentTask(agent, { ...good, name: "nightly", schedule: "15 0 * * *" }).ok).toBe(true);
  });

  test("refuses a task that posts into another agent's chat", () => {
    const r = checkAgentTask(agent, { ...good, telegramChatId: "-100999" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("own agent's chat");
  });

  test("allows naming its own chat explicitly", () => {
    expect(checkAgentTask(agent, { ...good, telegramChatId: agent.telegramChatId }).ok).toBe(true);
  });

  test("refuses a schedule that would starve the fleet", () => {
    const r = checkAgentTask(agent, { ...good, schedule: "* * * * *" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(String(MAX_RUNS_PER_DAY));
  });

  test("allows exactly the ceiling", () => {
    expect(checkAgentTask(agent, { ...good, schedule: "*/30 * * * *" }).ok).toBe(true);
  });

  test("refuses a schedule that never fires", () => {
    expect(checkAgentTask(agent, { ...good, schedule: "0 0 31 2 *" }).ok).toBe(false);
  });

  test("refuses malformed cron and missing fields", () => {
    expect(checkAgentTask(agent, { ...good, schedule: "every hour" }).ok).toBe(false);
    expect(checkAgentTask(agent, { name: "x", schedule: "0 * * * *" }).ok).toBe(false);
  });

  test("keeps the schema's timeout bounds", () => {
    expect(checkAgentTask(agent, { ...good, timeoutMs: 5 * 3_600_000 }).ok).toBe(false);
  });
});

describe("upsertTask / removeTask", () => {
  const a = { name: "a", schedule: "0 * * * *", prompt: "p", enabled: true };
  const b = { name: "b", schedule: "0 9 * * *", prompt: "p", enabled: true };

  test("adds, replaces by name, and never mutates input", () => {
    const start = [a];
    const added = upsertTask(start, b);
    expect(added.replaced).toBe(false);
    expect(added.tasks.map((t) => t.name)).toEqual(["a", "b"]);
    const replaced = upsertTask(added.tasks, { ...a, schedule: "30 * * * *" });
    expect(replaced.replaced).toBe(true);
    expect(replaced.tasks[0]!.schedule).toBe("30 * * * *");
    expect(start).toEqual([a]);
  });

  test("handles an agent with no tasks yet", () => {
    expect(upsertTask(undefined, a).tasks).toEqual([a]);
    expect(removeTask(undefined, "a").removed).toBe(false);
  });

  test("reports whether anything was removed", () => {
    expect(removeTask([a, b], "a")).toEqual({ tasks: [b], removed: true });
    expect(removeTask([a], "zzz").removed).toBe(false);
  });
});

describe("describeTaskChange", () => {
  test("says who, what, and how often", () => {
    const msg = describeTaskChange(agent, "added", good);
    expect(msg).toContain("LetterGnome");
    expect(msg).toContain("operator");
    expect(msg).toContain("9 runs/day");
    expect(msg).toContain("30 min");
  });
});
