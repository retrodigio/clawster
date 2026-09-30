/**
 * The rules for an agent managing its own schedule.
 *
 * Agents may not edit the fleet registry (`conduct.md` §7): it also holds
 * browser grants (`extraArgs`), restricted MCP servers, chat bindings and
 * workspaces, and an agent must never be able to hand itself any of those.
 * Scheduling is the one registry field an agent legitimately needs to own —
 * a project operator decides its own cadence — so it gets a narrow path of
 * its own, and these checks are what make that path safe to open.
 *
 * They run in the daemon, not in the agent's instructions, because an agent
 * reading the open web can be talked into things. Two failure modes matter:
 *
 *  - **Cross-chat delivery.** A task carries an optional `telegramChatId`. Left
 *    unchecked, an agent could schedule messages into any group the bot is in,
 *    including the family agents' chats. A task may only speak in its own chat.
 *  - **Fleet starvation.** `maxConcurrent` is 4 and task runs can last an hour.
 *    A `* * * * *` schedule would hold a slot permanently and queue every other
 *    agent's heartbeat behind it.
 *
 * Every change is announced as a new Telegram message in the agent's own group
 * (see `describeTaskChange`), so a schedule an agent set for itself is never
 * invisible.
 */
import { TaskSchema, isValidCronExpression } from "./config.ts";
import { matchesCron } from "./cron.ts";
import type { AgentConfig, TaskConfig } from "./types.ts";

export const MAX_TASKS_PER_AGENT = 10;
/** Every 30 minutes, around the clock. */
export const MAX_RUNS_PER_DAY = 48;

export type TaskCheck =
  | { ok: true; task: TaskConfig }
  | { ok: false; error: string };

/**
 * The most times `schedule` fires on any single day of a representative week.
 * A week, not a day, because day-of-week fields make some days busier.
 * Exported for testing.
 */
export function maxRunsPerDay(schedule: string): number {
  const start = new Date(2026, 0, 5, 0, 0, 0, 0); // a Monday, local time
  let busiest = 0;
  for (let day = 0; day < 7; day++) {
    let runs = 0;
    const t = new Date(start);
    t.setDate(start.getDate() + day);
    for (let minute = 0; minute < 24 * 60; minute++) {
      if (matchesCron(schedule, t)) runs++;
      t.setMinutes(t.getMinutes() + 1);
    }
    busiest = Math.max(busiest, runs);
  }
  return busiest;
}

/** Validate one task an agent wants to set on itself. */
export function checkAgentTask(agent: AgentConfig, input: unknown): TaskCheck {
  const parsed = TaskSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `Invalid task: ${issue?.path.join(".") || "task"} — ${issue?.message}` };
  }
  const task = parsed.data as TaskConfig;

  if (!isValidCronExpression(task.schedule)) {
    return { ok: false, error: `Invalid cron expression '${task.schedule}' (need 5 fields: minute hour day month weekday)` };
  }

  const runs = maxRunsPerDay(task.schedule);
  if (runs === 0) {
    return { ok: false, error: `Schedule '${task.schedule}' never fires` };
  }
  if (runs > MAX_RUNS_PER_DAY) {
    return {
      ok: false,
      error: `Schedule '${task.schedule}' fires ${runs} times a day; the limit is ${MAX_RUNS_PER_DAY} (every 30 minutes). ` +
        "Scheduled runs share a 4-slot semaphore with the whole fleet.",
    };
  }

  if (task.telegramChatId !== undefined && task.telegramChatId !== agent.telegramChatId) {
    return {
      ok: false,
      error: `A task may only post to its own agent's chat (${agent.telegramChatId}), not ${task.telegramChatId}`,
    };
  }

  return { ok: true, task };
}

/** Insert or replace by name. Pure — returns a new array. */
export function upsertTask(
  tasks: TaskConfig[] | undefined,
  task: TaskConfig,
): { tasks: TaskConfig[]; replaced: boolean } {
  const list = tasks ?? [];
  const idx = list.findIndex((t) => t.name === task.name);
  if (idx === -1) return { tasks: [...list, task], replaced: false };
  const next = [...list];
  next[idx] = task;
  return { tasks: next, replaced: true };
}

/** Remove by name. Pure — returns a new array. */
export function removeTask(
  tasks: TaskConfig[] | undefined,
  name: string,
): { tasks: TaskConfig[]; removed: boolean } {
  const list = tasks ?? [];
  const next = list.filter((t) => t.name !== name);
  return { tasks: next, removed: next.length !== list.length };
}

/** The Telegram notice posted to the agent's own group on every change. */
export function describeTaskChange(
  agent: AgentConfig,
  action: "added" | "updated" | "removed",
  task: Pick<TaskConfig, "name" | "schedule"> & Partial<TaskConfig>,
): string {
  if (action === "removed") {
    return `🗓 ${agent.name} removed its scheduled task "${task.name}".`;
  }
  const timeout = task.timeoutMs ? `, ${Math.round(task.timeoutMs / 60_000)} min budget` : "";
  const state = task.enabled === false ? " (disabled)" : "";
  return (
    `🗓 ${agent.name} ${action} its scheduled task "${task.name}"${state}\n` +
    `Schedule: ${task.schedule} · ${maxRunsPerDay(task.schedule)} runs/day${timeout}`
  );
}
