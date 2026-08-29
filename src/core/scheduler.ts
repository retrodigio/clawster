import { log } from "./logger.ts";
import { matchesCron, getNextMatch } from "./cron.ts";
import type { AgentConfig, TaskConfig } from "./types.ts";
import { appendOutbound, readRecentOutbound, formatJournalForPrompt } from "./outbound-journal.ts";

type RunOpts = { timeout?: number; priority?: "high" | "low"; sessionScope?: string };

type Runner = {
  run(agent: AgentConfig, prompt: string, opts?: RunOpts): Promise<string>;
  runStructured?(
    agent: AgentConfig,
    prompt: string,
    outputFormat: unknown,
    opts?: RunOpts,
  ): Promise<{ text: string; structured?: unknown }>;
};

/**
 * What a scheduled wake returns.
 *
 * `checkin` is the whole point: the decision to speak becomes a boolean field
 * the model fills, not a sentinel string a caller has to find in prose. The
 * old contract — "respond with exactly NO_CHECKIN" — failed open. Any agent
 * that prefixed a word, explained itself, or wrapped the token in a sentence
 * had its narration posted to Telegram as a check-in.
 */
export const CHECKIN_SCHEMA = {
  type: "json_schema" as const,
  schema: {
    type: "object",
    properties: {
      checkin: {
        type: "boolean",
        description:
          "true only if there is something worth interrupting Chris for. false when nothing notable happened — silence is the correct and expected outcome for most wakes.",
      },
      message: {
        type: "string",
        description:
          "The Telegram message to send. Required when checkin is true; omit it entirely when checkin is false.",
      },
    },
    required: ["checkin"],
    additionalProperties: false,
  },
};

/**
 * Decide whether a wake's output should reach Telegram.
 *
 * Three layers, most trustworthy first, because a scheduled run can fail in
 * ways that leave any single layer blind:
 *
 *   1. The parsed schema object — what we asked for.
 *   2. JSON in the text — the model conformed but the SDK didn't surface it.
 *   3. The legacy sentinel — a task whose prompt predates the schema.
 *
 * Every ambiguous case resolves to silence. A wrongly-silent wake costs one
 * missed check-in; a wrongly-sent one posts raw JSON or an error string into a
 * family group chat.
 */
export function interpretCheckin(
  text: string,
  structured?: unknown,
): { send: boolean; message?: string; via: "schema" | "json" | "sentinel" } {
  const fromObject = (
    obj: unknown,
    via: "schema" | "json",
  ): { send: boolean; message?: string; via: "schema" | "json" } | null => {
    if (!obj || typeof obj !== "object") return null;
    const o = obj as { checkin?: unknown; message?: unknown };
    if (typeof o.checkin !== "boolean") return null;
    if (!o.checkin) return { send: false, via };
    const message = typeof o.message === "string" ? o.message.trim() : "";
    // checkin:true with nothing to say is a contradiction. Believe the absence
    // of a message over the flag — there is literally nothing to send.
    if (!message || message === "NO_CHECKIN") return { send: false, via };
    return { send: true, message, via };
  };

  const viaSchema = fromObject(structured, "schema");
  if (viaSchema) return viaSchema;

  const trimmed = text.trim();

  // The SDK gave us no object, but `outputFormat` makes the text itself JSON.
  // Parse it rather than posting a raw object to a chat.
  if (trimmed.startsWith("{")) {
    try {
      const viaJson = fromObject(JSON.parse(trimmed), "json");
      if (viaJson) return viaJson;
    } catch {
      // Fall through — malformed JSON is not a check-in.
    }
    return { send: false, via: "json" };
  }

  // Legacy sentinel, for tasks whose prompts predate the schema.
  if (trimmed === "" || trimmed.startsWith("NO_CHECKIN")) return { send: false, via: "sentinel" };
  return { send: true, message: trimmed, via: "sentinel" };
}

/** Convert a time zone to a Date representing the current wall-clock time in that zone. */
function getTimeInZone(timezone: string): Date {
  const now = new Date();
  const tzString = now.toLocaleString("en-US", { timeZone: timezone });
  return new Date(tzString);
}

function formatTime(timezone: string): string {
  return new Date().toLocaleString("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

function buildHeartbeatPrompt(agent: AgentConfig, timezone: string): string {
  return `You are ${agent.name}, running a proactive check-in for your project.

Current time: ${formatTime(timezone)}

Before composing anything, read ~/projects/clawster-orchestrator/prompts/conduct.md
and apply it — the pre-send gate, answer-first shape, and citation rules all
apply to this message. Skip its §4: you are a scheduled wake with no plugin
tools, so there is no status message to edit.

INSTRUCTIONS:
- Check the state of this project. Look at recent git activity, any pending work, the state of the codebase.
- If there's something worth telling Chris about (a failing build, something interesting you notice, a suggestion, or a status update), set checkin to true and put a brief, conversational message in the message field.
- If nothing notable is happening, set checkin to false and omit message. This is the expected outcome for most wakes.
- Keep messages short and actionable — this goes to Telegram.
- Don't check in just to say "everything is fine" — that is what checkin:false is for.
- Max 2-3 check-ins per day per project. If you've been checking in frequently, lean toward checkin:false.`;
}

/**
 * Convert a heartbeat interval string ("30m", "1h", "2h") to a cron expression.
 * If activeHours is provided, constrains the hour field accordingly.
 */
function heartbeatToCron(every: string, activeHours?: { start: string; end: string }): string {
  const match = every.match(/^(\d+)(m|h)$/);
  if (!match) throw new Error(`Invalid heartbeat interval: ${every}`);

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;

  let minuteField: string;
  let hourField: string;

  if (unit === "m") {
    // e.g. "30m" -> "*/30 * * * *"
    minuteField = `*/${value}`;
    hourField = "*";
  } else {
    // e.g. "1h" -> "0 * * * *", "2h" -> "0 */2 * * *"
    minuteField = "0";
    hourField = value === 1 ? "*" : `*/${value}`;
  }

  if (activeHours) {
    const startHour = parseInt(activeHours.start.split(":")[0]!, 10);
    const endHour = parseInt(activeHours.end.split(":")[0]!, 10);
    hourField = unit === "m" ? `${startHour}-${endHour}` : (value === 1 ? `${startHour}-${endHour}` : `${startHour}-${endHour}/${value}`);
  }

  return `${minuteField} ${hourField} * * *`;
}

/**
 * Send a check-in, reporting the message id of the FIRST chunk.
 *
 * That id is the citable anchor. Conduct §3 asks for a t.me permalink when
 * referring back to a past statement, and the outbound journal needs somewhere
 * to point; a long check-in splits across several messages but the claim lives
 * in the first one, so that is the one worth remembering.
 *
 * `ok` is reported separately from `messageId` because a send can succeed
 * while the id is unrecoverable (unparseable response body). Delivered but
 * unciteable is a degradation, not a failure — don't conflate the two.
 */
async function sendTelegram(
  botToken: string,
  chatId: string,
  text: string,
  topicId?: number,
): Promise<{ ok: boolean; messageId?: number }> {
  // Telegram hard limit is 4096 chars/message — chunk long check-ins instead
  // of letting the whole send fail.
  const MAX = 4000;
  let messageId: number | undefined;
  for (let i = 0; i < text.length; i += MAX) {
    const body: Record<string, unknown> = { chat_id: chatId, text: text.slice(i, i + MAX) };
    if (topicId) body.message_thread_id = topicId;
    const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) return { ok: false };
    if (messageId === undefined) {
      const payload = (await response.json().catch(() => null)) as
        | { result?: { message_id?: number } }
        | null;
      messageId = payload?.result?.message_id;
    }
  }
  return messageId === undefined ? { ok: true } : { ok: true, messageId };
}

/** Resolve the effective task list for an agent, converting legacy heartbeat config if needed. */
function resolveAgentTasks(agent: AgentConfig, timezone: string): TaskConfig[] {
  if (agent.tasks && agent.tasks.length > 0) {
    return agent.tasks;
  }

  // Legacy heartbeat conversion
  if (agent.heartbeat) {
    const hb = agent.heartbeat;
    return [
      {
        name: "heartbeat",
        schedule: heartbeatToCron(hb.every, hb.activeHours),
        prompt: buildHeartbeatPrompt(agent, timezone),
        telegramChatId: hb.to,
      },
    ];
  }

  return [];
}

export function startScheduler(
  getAgents: () => AgentConfig[],
  runner: Runner,
  botToken: string,
  timezone: string,
): void {
  const lastRun = new Map<string, number>();

  // Tasks are re-derived from the config store on every tick (cheap at fleet
  // scale) so agent/heartbeat edits apply without a restart.
  function buildTasks(): { agent: AgentConfig; task: TaskConfig }[] {
    const allTasks: { agent: AgentConfig; task: TaskConfig }[] = [];
    for (const agent of getAgents()) {
      for (const task of resolveAgentTasks(agent, timezone)) {
        allTasks.push({ agent, task });
      }
    }
    return allTasks;
  }

  // Log what we're scheduling at startup
  const initialTasks = buildTasks();
  for (const { agent, task } of initialTasks) {
    const next = getNextMatch(task.schedule, getTimeInZone(timezone));
    const nextStr = next.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    log.info("scheduler", `Scheduled task ${agent.id}:${task.name}`, {
      schedule: task.schedule,
      enabled: task.enabled !== false,
      nextRun: nextStr,
    });
  }

  log.info("scheduler", `Scheduler started with ${initialTasks.length} task(s)`);

  // Check every 60 seconds
  setInterval(() => {
    const allTasks = buildTasks();
    const now = getTimeInZone(timezone);
    const currentMinuteKey = `${now.getFullYear()}-${now.getMonth()}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}`;

    for (const { agent, task } of allTasks) {
      if (task.enabled === false) continue;

      const taskKey = `${agent.id}:${task.name}`;
      const runKey = `${taskKey}:${currentMinuteKey}`;

      if (lastRun.has(runKey)) continue;

      if (!matchesCron(task.schedule, now)) continue;

      // Mark as run for this minute
      lastRun.set(runKey, Date.now());

      // Clean up old entries (keep last hour only)
      const oneHourAgo = Date.now() - 3_600_000;
      for (const [key, timestamp] of lastRun) {
        if (timestamp < oneHourAgo) lastRun.delete(key);
      }

      log.info("scheduler", `Running task ${taskKey}`, { schedule: task.schedule });

      // Fire and forget — don't block the tick loop
      (async () => {
        try {
          // 10-minute ceiling: heartbeat prompts ask the agent to review git
          // and project state, which legitimately takes minutes on a cold
          // cache. The old 2-minute ceiling produced timeout messages that
          // then got SENT as check-ins.
          // sessionScope keeps scheduled runs in their own session so they
          // never advance the user's conversation pointer.
          // A scheduled wake is a fresh process with no memory of the last
          // one. Hand it what it previously said unprompted, so it can avoid
          // repeating itself and can honour conduct §8 — no NO_CHECKIN while a
          // blocker it already reported is still standing.
          const journal = formatJournalForPrompt(await readRecentOutbound(agent.id), timezone);
          const prompt = journal ? `${task.prompt}\n\n---\n\n${journal}` : task.prompt;

          const runOpts: RunOpts = {
            timeout: task.timeoutMs ?? 600_000,
            priority: "low",
            sessionScope: "scheduled",
          };

          // Ask for the schema when the runner supports it. The `run` fallback
          // keeps injected test doubles and any older runner working.
          const { text, structured } = runner.runStructured
            ? await runner.runStructured(agent, prompt, CHECKIN_SCHEMA, runOpts)
            : { text: await runner.run(agent, prompt, runOpts), structured: undefined };

          // Runner timeout text is a failure report, not agent output — never
          // deliver it as a check-in. Checked before interpretation, because a
          // timeout produces prose that the sentinel path would read as a send.
          if (/became unresponsive\. Session is saved/i.test(text)) {
            log.warn("scheduler", `Task ${taskKey}: run timed out — suppressing check-in`);
            return;
          }

          const decision = interpretCheckin(text, structured);
          if (!decision.send) {
            log.info("scheduler", `Task ${taskKey}: no output to send`, { via: decision.via });
            return;
          }
          const trimmed = decision.message!;

          const chatId = task.telegramChatId || agent.telegramChatId;
          if (!chatId) {
            log.warn("scheduler", `Task ${taskKey}: no chat ID to send to`);
            return;
          }

          const sent = await sendTelegram(botToken, chatId, trimmed, task.topicId);
          if (!sent.ok) {
            log.warn("scheduler", `Task ${taskKey}: failed to send Telegram message`, { chatId });
            return;
          }

          log.info("scheduler", `Task ${taskKey}: sent to Telegram`, { chatId, topicId: task.topicId });

          if (sent.messageId !== undefined) {
            await appendOutbound({
              agentId: agent.id,
              task: task.name,
              chatId,
              ...(task.topicId ? { topicId: task.topicId } : {}),
              messageId: sent.messageId,
              text: trimmed,
            });
          }
        } catch (err) {
          log.error("scheduler", `Task ${taskKey} failed`, { error: String(err) });
        }
      })();
    }
  }, 60_000);
}
