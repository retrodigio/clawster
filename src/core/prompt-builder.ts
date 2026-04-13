import type { AgentConfig, MessageContext } from "./types.ts";

function formatTime(timezone: string): string {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  return formatter.format(now);
}

export function buildPrompt(
  agent: AgentConfig,
  userMessage: string,
  context: MessageContext,
  timezone: string = "America/Denver",
): string {
  const parts: string[] = [];

  if (context.topicId) {
    const topicLabel = context.topicName ?? `Topic #${context.topicId}`;
    parts.push(`[${agent.name} — ${topicLabel}]`);
  }

  parts.push(`Current time: ${formatTime(timezone)}`);
  parts.push(userMessage);

  return parts.join("\n\n");
}
