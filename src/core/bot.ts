import { Bot } from "grammy";
import type { AgentConfig } from "./types.ts";
import type { ActivityStatus } from "./agent-runner.ts";
import { log } from "./logger.ts";
import { registerTextHandler } from "./handlers/text-handler.ts";
import { registerMediaHandlers } from "./handlers/media-handler.ts";
import { registerCommandHandler } from "./handlers/command-handler.ts";
import type { HandlerDeps } from "./handlers/types.ts";
import { classifyTelegramError } from "./telegram-errors.ts";
import { unbindDeadChat } from "./router.ts";

interface CreateBotOptions {
  botToken: string;
  allowedUserId: string;
  groqKey?: string;
  resolveAgent: (chatId: string, isPrivate: boolean) => AgentConfig | null;
  runner: {
    run(agent: AgentConfig, prompt: string, opts?: { topicId?: number }): Promise<string>;
    runStreaming(agent: AgentConfig, prompt: string, onUpdate: (textSoFar: string) => void, opts?: { topicId?: number; timeout?: number; onActivity?: (status: ActivityStatus) => void; onBusy?: "interrupt" | "queue" }): Promise<{ text: string; sessionId: string | null }>;
  };
  agentById: Map<string, AgentConfig>;
}

export type AuthDecision =
  | { allow: true; reason: "owner" | "mapped_group"; agent?: AgentConfig | null }
  | { allow: false; reason: "no_from" | "not_owner_dm" | "not_owner_unmapped_group" | "not_owner_channel" };

/**
 * Decide whether a Telegram update should be allowed through the auth gate.
 *
 * Rules:
 *  - DMs (private chats): owner-only.
 *  - Group / supergroup: owner always allowed. Non-owners allowed iff the chat
 *    is mapped to a configured agent (someone Chris intentionally added to the
 *    agent's group can talk to that agent).
 *  - Channel posts, unmapped groups, unknown chat types: owner-only.
 */
export function decideAuth(params: {
  fromId: string | undefined;
  chatId: string | undefined;
  chatType: "private" | "group" | "supergroup" | "channel" | undefined;
  allowedUserId: string;
  resolveAgent: (chatId: string, isPrivate: boolean) => AgentConfig | null;
}): AuthDecision {
  const { fromId, chatId, chatType, allowedUserId, resolveAgent } = params;

  if (!fromId) return { allow: false, reason: "no_from" };

  const isOwner = fromId === allowedUserId;
  if (isOwner) return { allow: true, reason: "owner" };

  const isGroup = chatType === "group" || chatType === "supergroup";
  if (!isGroup || !chatId) {
    // DMs and channel posts fall back to owner-only.
    if (chatType === "channel") return { allow: false, reason: "not_owner_channel" };
    return { allow: false, reason: "not_owner_dm" };
  }

  const agent = resolveAgent(chatId, false);
  if (agent) return { allow: true, reason: "mapped_group", agent };

  return { allow: false, reason: "not_owner_unmapped_group" };
}

export function createBot({ botToken, allowedUserId, groqKey, resolveAgent, runner, agentById }: CreateBotOptions) {
  const bot = new Bot(botToken);

  // Install API-level error transformer — classify Telegram API errors so we
  // can differentiate between expected edit-failures, permanent chat failures
  // (bot kicked/blocked/chat deleted), rate limits, and unknowns. Only the
  // classified-safe categories are swallowed; unknowns are re-thrown so the
  // bot middleware / handlers can react (and grammY's `bot.catch` will log).
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err: any) {
      const classified = classifyTelegramError(err, method);
      const chatId = (payload as any)?.chat_id ?? "unknown";

      switch (classified.kind) {
        case "expected_edit":
          // Streaming edit collided with an identical / stale target message —
          // normal during live token streaming. Log at debug, return a truthy
          // sentinel so grammY doesn't throw. (Note: callers that read
          // `message_id` off the result will get undefined — which is fine for
          // the edit paths because no further work depends on the new message.)
          log.info("telegram", `Edit no-op on ${method}`, {
            code: classified.code,
            desc: classified.description,
            chatId,
          });
          return { ok: true, result: true } as any;

        case "permanent_chat":
          // Bot was kicked, user blocked, chat deleted. Swallow so we don't
          // crash — log at warn AND auto-unbind the chat from its agent so we
          // stop sending heartbeats / retrying to a dead target. Fire-and-forget
          // so the transformer can return promptly.
          log.warn("telegram", `Chat unavailable on ${method} — suppressing`, {
            code: classified.code,
            desc: classified.description,
            chatId,
          });
          // Telegram sends chat_id as a number; normalize to string for the router map.
          const chatIdStr = typeof chatId === "number" ? chatId.toString() : chatId;
          if (typeof chatIdStr === "string" && chatIdStr !== "unknown") {
            unbindDeadChat(chatIdStr).catch((err) => {
              log.error("telegram", "unbindDeadChat failed", { chatId: chatIdStr, error: String(err) });
            });
          }
          return { ok: true, result: true } as any;

        case "rate_limit":
          // Let grammY's built-in auto-retry handle this by re-throwing.
          log.warn("telegram", `Rate limited on ${method}`, {
            code: classified.code,
            desc: classified.description,
            retryAfter: (err as any)?.parameters?.retry_after,
          });
          throw err;

        case "unknown":
        default:
          log.error("telegram", `Unexpected API error on ${method}`, {
            code: classified.code,
            desc: classified.description,
            chatId,
          });
          throw err;
      }
    }
  });

  // Auth middleware — owner everywhere; non-owners only in mapped group chats.
  bot.use(async (ctx, next) => {
    const fromId = ctx.from?.id.toString();
    const chatId = ctx.chat?.id.toString();
    const chatType = ctx.chat?.type;

    const decision = decideAuth({
      fromId,
      chatId,
      chatType,
      allowedUserId,
      resolveAgent,
    });

    if (!decision.allow) {
      try {
        await ctx.reply("This bot is private.");
      } catch (err: any) {
        log.warn("telegram", "API call failed (non-fatal)", { error: err?.description ?? String(err) });
      }
      return;
    }

    if (decision.reason === "mapped_group") {
      log.info("auth", "Non-owner in mapped group", {
        chatId,
        agentId: decision.agent?.id,
        fromId,
        fromUsername: ctx.from?.username,
      });
    }

    await next();
  });

  // Build shared dependencies for handlers
  const deps: HandlerDeps = {
    botToken,
    resolveAgent,
    runner,
    agentById,
    allowedUserId,
    groqKey,
  };

  // Register all message handlers. Command handler first so `/help` etc.
  // take precedence over the generic text handler.
  registerCommandHandler(bot, deps);
  registerTextHandler(bot, deps);
  registerMediaHandlers(bot, deps);

  // Global error handler — never let an unhandled error crash the process
  bot.catch((err) => {
    const ctx = err.ctx;
    const chatId = ctx?.chat?.id?.toString() ?? "unknown";
    log.error("bot", "Unhandled error in bot middleware", {
      chatId,
      error: String(err.error),
      message: err.message,
    });
    // Don't re-throw — the bot must keep running
  });

  return bot;
}
