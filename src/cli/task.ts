import { Command } from "commander";
import { readFile } from "fs/promises";
import { loadApiToken, loadBaseUrl } from "./api-client.ts";

/**
 * `clawster task` — let an agent manage its OWN scheduled tasks.
 *
 * This goes through the daemon's API rather than writing agents.json, for two
 * reasons: a direct file edit never reaches the running daemon's in-memory
 * config, and the daemon is where the safety checks live (own chat only, a
 * run-frequency ceiling, a per-agent cap — see src/core/task-policy.ts). Every
 * change is also announced in the agent's own Telegram group.
 *
 * Changes apply on the scheduler's next tick. No restart.
 */

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const [token, baseUrl] = await Promise.all([loadApiToken(), loadBaseUrl()]);
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`✗ ${(data as any).error ?? `HTTP ${resp.status}`}`);
    process.exit(1);
  }
  return data;
}

const taskPath = (agentId: string, name?: string) =>
  `/api/agents/${encodeURIComponent(agentId)}/tasks` + (name ? `/${encodeURIComponent(name)}` : "");

async function putTask(agentId: string, task: Record<string, unknown>): Promise<void> {
  const name = task.name;
  if (typeof name !== "string" || !name) {
    console.error("✗ Every task needs a \"name\".");
    process.exit(1);
  }
  const data = await api("PUT", taskPath(agentId, name), task);
  console.log(`✓ ${data.action} "${name}" on ${agentId} — ${data.task.schedule}`);
}

export const taskCommand = new Command("task")
  .description("Manage an agent's own scheduled tasks (applies live, no restart)");

taskCommand
  .command("list")
  .description("Show an agent's scheduled tasks")
  .argument("<agentId>")
  .action(async (agentId: string) => {
    const { tasks } = await api("GET", taskPath(agentId));
    if (!tasks.length) {
      console.log(`${agentId} has no scheduled tasks.`);
      return;
    }
    for (const t of tasks) {
      const budget = t.timeoutMs ? ` · ${Math.round(t.timeoutMs / 60_000)}m` : "";
      const off = t.enabled === false ? " · disabled" : "";
      console.log(`${t.name.padEnd(16)} ${t.schedule.padEnd(18)}${budget}${off}`);
      console.log(`  ${String(t.prompt).slice(0, 110)}${t.prompt.length > 110 ? "…" : ""}`);
    }
  });

taskCommand
  .command("set")
  .description("Add or replace tasks from a JSON file (one task object, an array, or { \"tasks\": [...] })")
  .argument("<agentId>")
  .argument("<file>", "JSON file; use - for stdin")
  .action(async (agentId: string, file: string) => {
    const raw = file === "-" ? await Bun.stdin.text() : await readFile(file, "utf-8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      console.error(`✗ ${file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    const list = Array.isArray(parsed)
      ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as any).tasks)
        ? (parsed as any).tasks
        : [parsed];
    // Sequential so a rejection stops the batch at the task that caused it.
    for (const task of list) await putTask(agentId, task);
  });

taskCommand
  .command("add")
  .description("Add or replace a single task")
  .argument("<agentId>")
  .requiredOption("-n, --name <name>")
  .requiredOption("-s, --schedule <cron>", "5-field cron, fleet timezone, e.g. \"0 7-23/2 * * *\"")
  .option("-p, --prompt <text>", "Prompt for the scheduled run")
  .option("-f, --prompt-file <path>", "Read the prompt from a file instead")
  .option("-t, --timeout <minutes>", "Run budget in minutes (1-60)", (v) => Number(v))
  .option("--disabled", "Save it switched off")
  .action(async (agentId: string, opts: {
    name: string; schedule: string; prompt?: string; promptFile?: string; timeout?: number; disabled?: boolean;
  }) => {
    const prompt = opts.promptFile ? (await readFile(opts.promptFile, "utf-8")).trim() : opts.prompt;
    if (!prompt) {
      console.error("✗ Give a --prompt or a --prompt-file.");
      process.exit(1);
    }
    await putTask(agentId, {
      name: opts.name,
      schedule: opts.schedule,
      prompt,
      ...(opts.timeout ? { timeoutMs: Math.round(opts.timeout * 60_000) } : {}),
      ...(opts.disabled ? { enabled: false } : {}),
    });
  });

taskCommand
  .command("remove")
  .description("Remove a task by name")
  .argument("<agentId>")
  .argument("<name>")
  .action(async (agentId: string, name: string) => {
    await api("DELETE", taskPath(agentId, name));
    console.log(`✓ removed "${name}" from ${agentId}`);
  });
