import { log } from "./logger.ts";
import { matchesCron, getNextMatch } from "./cron.ts";
import type { AgentConfig, TaskConfig } from "./types.ts";

type Runner = {
  run(agent: AgentConfig, prompt: string, opts?: { timeout?: number }): Promise<string>;
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

async function sendTelegram(botToken: string, chatId: string, text: string, topicId?: number): Promise<boolean> {
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (topicId) body.message_thread_id = topicId;
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return response.ok;
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

export function startScheduler(agents: AgentConfig[], runner: Runner, botToken: string, timezone: string): void {
  const lastRun = new Map<string, number>();

  const allTasks: { agent: AgentConfig; task: TaskConfig }[] = [];
  for (const agent of agents) {
    const tasks = resolveAgentTasks(agent, timezone);
    for (const task of tasks) {
      allTasks.push({ agent, task });
    }
  }

  if (allTasks.length === 0) {
    log.info("scheduler", "No agents with tasks or heartbeats — scheduler idle");
    return;
  }

  // Log what we're scheduling
  for (const { agent, task } of allTasks) {
    const next = getNextMatch(task.schedule, getTimeInZone(timezone));
    const nextStr = next.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
    log.info("scheduler", `Scheduled task ${agent.id}:${task.name}`, {
      schedule: task.schedule,
      enabled: task.enabled !== false,
      nextRun: nextStr,
    });
  }

  log.info("scheduler", `Scheduler started with ${allTasks.length} task(s) across ${agents.length} agent(s)`);

  // Check every 60 seconds
  setInterval(() => {
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
          const response = await runner.run(agent, task.prompt, { timeout: 120_000 });
          const trimmed = response.trim();

          if (trimmed === "NO_CHECKIN" || trimmed.startsWith("NO_CHECKIN") || trimmed === "") {
            log.info("scheduler", `Task ${taskKey}: no output to send`);
            return;
          }

          const chatId = task.telegramChatId || agent.telegramChatId;
          if (!chatId) {
            log.warn("scheduler", `Task ${taskKey}: no chat ID to send to`);
            return;
          }

          const sent = await sendTelegram(botToken, chatId, trimmed, task.topicId);
          if (sent) {
            log.info("scheduler", `Task ${taskKey}: sent to Telegram`, { chatId, topicId: task.topicId });
          } else {
            log.warn("scheduler", `Task ${taskKey}: failed to send Telegram message`, { chatId });
          }
        } catch (err) {
          log.error("scheduler", `Task ${taskKey} failed`, { error: String(err) });
        }
      })();
    }
  }, 60_000);
}
