import { log } from "./logger.ts";
import { matchesCron, getNextMatch } from "./cron.ts";
import type { AgentConfig, TaskConfig } from "./types.ts";
import { appendOutbound, readRecentOutbound, formatJournalForPrompt } from "./outbound-journal.ts";

type Runner = {
  run(
    agent: AgentConfig,
    prompt: string,
    opts?: { timeout?: number; priority?: "high" | "low"; sessionScope?: string },
  ): Promise<string>;
};

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
- If there's something worth telling Chris about (a failing build, something interesting you notice, a suggestion, or a status update), compose a brief, conversational message.
- If nothing notable is happening, respond with exactly: NO_CHECKIN
- Keep messages short and actionable — this goes to Telegram.
- Don't check in just to say "everything is fine" — that's what NO_CHECKIN is for.
- Max 2-3 check-ins per day per project. If you've been checking in frequently, lean toward NO_CHECKIN.`;
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

          const response = await runner.run(agent, prompt, {
            timeout: task.timeoutMs ?? 600_000,
            priority: "low",
            sessionScope: "scheduled",
          });
          const trimmed = response.trim();

          if (trimmed === "NO_CHECKIN" || trimmed.startsWith("NO_CHECKIN") || trimmed === "") {
            log.info("scheduler", `Task ${taskKey}: no output to send`);
            return;
          }

          // Runner timeout text is a failure report, not agent output — never
          // deliver it as a check-in.
          if (/became unresponsive\. Session is saved/i.test(trimmed)) {
            log.warn("scheduler", `Task ${taskKey}: run timed out — suppressing check-in`);
            return;
          }

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
