import type { AgentConfig, MessageContext } from "./types.ts";
import { log } from "./logger.ts";

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
  let message = userMessage;

  // /goal passthrough: if the user message starts with "/goal <condition>",
  // hoist that line to the very top of the prompt so Claude Code's slash-command
  // parser sees it before any orchestrator-injected context (topic label, time
  // header). The condition becomes a session-scoped completion gate — Claude
  // keeps iterating until a Haiku judge says the condition is satisfied.
  // See: https://code.claude.com/docs/en/goal
  const goalMatch = userMessage.trimStart().match(/^\/goal\s+([^\n]+)(?:\n([\s\S]*))?$/i);
  if (goalMatch && goalMatch[1]) {
    const condition = goalMatch[1].trim();
    const rest = (goalMatch[2] ?? "").trim();
    log.info(agent.id, "Goal directive detected in user message", {
      conditionLen: condition.length,
      condition: condition.slice(0, 200),
      hasFollowup: rest.length > 0,
    });
    parts.push(`/goal ${condition}`);
    message = rest;
  }

  if (context.topicId) {
    const topicLabel = context.topicName ?? `Topic #${context.topicId}`;
    parts.push(`[${agent.name} — ${topicLabel}]`);
  }

  parts.push(`Current time: ${formatTime(timezone)}`);
  if (message) parts.push(message);

  return parts.join("\n\n");
}
