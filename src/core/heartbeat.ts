import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";

type Runner = {
  run(agent: AgentConfig, prompt: string, opts?: { timeout?: number }): Promise<string>;
};

function parseInterval(s: string): number {
  const match = s.match(/^(\d+)(m|h)$/);
  if (!match) throw new Error(`Invalid interval: ${s}`);
  const value = parseInt(match[1]!, 10);
  const unit = match[2]!;
  if (unit === "m") return value * 60_000;
  return value * 3_600_000;
}

function getTimeInZone(timezone: string): Date {
  const now = new Date();
  const tzString = now.toLocaleString("en-US", { timeZone: timezone });
  return new Date(tzString);
}

function isWithinActiveHours(activeHours: { start: string; end: string }, timezone: string): boolean {
  const mt = getTimeInZone(timezone);
  const currentMinutes = mt.getHours() * 60 + mt.getMinutes();

  const startParts = activeHours.start.split(":").map(Number);
  const endParts = activeHours.end.split(":").map(Number);

  const startMinutes = (startParts[0] ?? 0) * 60 + (startParts[1] ?? 0);
  const endMinutes = (endParts[0] ?? 0) * 60 + (endParts[1] ?? 0);

  return currentMinutes >= startMinutes && currentMinutes < endMinutes;
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

async function sendTelegram(botToken: string, chatId: string, text: string): Promise<boolean> {
  const response = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  return response.ok;
}

async function heartbeatTick(agent: AgentConfig, runner: Runner, botToken: string, timezone: string): Promise<void> {
  const hb = agent.heartbeat!;

  if (hb.activeHours && !isWithinActiveHours(hb.activeHours, timezone)) {
    log.debug(agent.id, "Heartbeat skipped — outside active hours");
    return;
  }

  try {
    const prompt = buildHeartbeatPrompt(agent, timezone);
    const response = await runner.run(agent, prompt, { timeout: 120_000 });
    const trimmed = response.trim();

    if (trimmed === "NO_CHECKIN" || trimmed.startsWith("NO_CHECKIN")) {
      log.info(agent.id, "Heartbeat: no check-in needed");
      return;
    }

    const sent = await sendTelegram(botToken, hb.to, trimmed);
    if (sent) {
      log.info(agent.id, "Heartbeat: check-in sent to Telegram", { chatId: hb.to });
    } else {
      log.warn(agent.id, "Heartbeat: failed to send Telegram message", { chatId: hb.to });
    }
  } catch (err) {
    log.error(agent.id, "Heartbeat tick failed", { error: String(err) });
  }
}

export function startHeartbeats(agents: AgentConfig[], runner: Runner, botToken: string, timezone: string): void {
  const heartbeatAgents = agents.filter((a) => a.heartbeat);

  if (heartbeatAgents.length === 0) {
    log.info("heartbeat", "No agents with heartbeat config — skipping");
    return;
  }

  for (const agent of heartbeatAgents) {
    const hb = agent.heartbeat!;
    const intervalMs = parseInterval(hb.every);
    const staggerMs = Math.floor(Math.random() * 60_000);

    log.info("heartbeat", `Scheduling heartbeat for ${agent.id}`, {
      every: hb.every,
      intervalMs,
      staggerMs,
      activeHours: hb.activeHours ?? null,
    });

    setTimeout(() => {
      // Run first tick, then set up interval
      heartbeatTick(agent, runner, botToken, timezone);
      setInterval(() => heartbeatTick(agent, runner, botToken, timezone), intervalMs);
    }, staggerMs);
  }

  log.info("heartbeat", `Started heartbeats for ${heartbeatAgents.length} agent(s)`);
}
