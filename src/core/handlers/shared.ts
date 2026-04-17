import type { AgentConfig } from "../types.ts";
import { log } from "../logger.ts";

/** Safely send/edit Telegram messages — never throw on API errors. */
export async function safeSend(fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: any) {
    const desc = err?.description ?? String(err);
    log.warn("telegram", "API call failed (non-fatal)", { error: desc });
    return null;
  }
}

/** Safely set a message reaction — never throw if Telegram rejects it. */
export async function safeReact(ctx: any, emoji: string): Promise<void> {
  try {
    await ctx.react(emoji);
  } catch (err: any) {
    log.warn("telegram", "Reaction failed (non-fatal)", { emoji, error: err?.description ?? String(err) });
  }
}

/** Resolve topic name from config or Telegram metadata. */
export function resolveTopicName(agent: AgentConfig, topicId: number | undefined, ctx: any): string | undefined {
  if (!topicId) return undefined;
  const fromConfig = agent.topics?.[topicId.toString()]?.name;
  if (fromConfig) return fromConfig;
  // Telegram includes forum_topic_created in reply_to_message for topic messages
  const replyMsg = ctx.message?.reply_to_message;
  if (replyMsg?.forum_topic_created?.name) {
    return replyMsg.forum_topic_created.name;
  }
  // General topic (ID 1) doesn't include forum_topic_created
  if (topicId === 1) return "General";
  return `Topic ${topicId}`;
}
