import { Bot } from "grammy";
import type { AgentConfig } from "./types.ts";
import type { ActivityStatus } from "./agent-runner.ts";
import { log } from "./logger.ts";
import { registerTextHandler } from "./handlers/text-handler.ts";
import { registerMediaHandlers } from "./handlers/media-handler.ts";
import type { HandlerDeps } from "./handlers/types.ts";
import { classifyTelegramError } from "./telegram-errors.ts";

interface CreateBotOptions {
  botToken: string;
  allowedUserId: string;
  groqKey?: string;
  resolveAgent: (chatId: string, isPrivate: boolean) => AgentConfig | null;
  runner: {
    run(agent: AgentConfig, prompt: string, opts?: { topicId?: number }): Promise<string>;
    runStreaming(agent: AgentConfig, prompt: string, onUpdate: (textSoFar: string) => void, opts?: { topicId?: number; timeout?: number; onActivity?: (status: ActivityStatus) => void }): Promise<{ text: string; sessionId: string | null }>;
  };
  agentById: Map<string, AgentConfig>;
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
          // crash — but log at warn so the user can spot dead chats in logs.
          log.warn("telegram", `Chat unavailable on ${method} — suppressing`, {
            code: classified.code,
            desc: classified.description,
            chatId,
          });
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

  // Auth middleware — only allowed user can interact
  bot.use(async (ctx, next) => {
    if (ctx.from?.id.toString() !== allowedUserId) {
      try {
        await ctx.reply("This bot is private.");
      } catch (err: any) {
        log.warn("telegram", "API call failed (non-fatal)", { error: err?.description ?? String(err) });
      }
      return;
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

  // Register all message handlers
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
