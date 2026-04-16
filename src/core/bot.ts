import { Bot } from "grammy";
import type { AgentConfig } from "./types.ts";
import type { ActivityStatus } from "./agent-runner.ts";
import { log } from "./logger.ts";
import { registerTextHandler } from "./handlers/text-handler.ts";
import { registerMediaHandlers } from "./handlers/media-handler.ts";
import type { HandlerDeps } from "./handlers/types.ts";

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

  // Install API-level error transformer — catch Telegram API errors (403, 400, etc.)
  // before they can bubble up as unhandled exceptions and crash the process.
  bot.api.config.use(async (prev, method, payload, signal) => {
    try {
      return await prev(method, payload, signal);
    } catch (err: any) {
      const code = err?.error_code ?? 0;
      const desc = err?.description ?? String(err);
      // Swallow known non-fatal errors
      if (code === 403 || code === 400) {
        log.warn("telegram", `API error ${code} on ${method} (swallowed)`, { error: desc });
        // Return a fake "ok" response so grammY doesn't throw
        return { ok: true, result: true } as any;
      }
      throw err; // Re-throw unknown errors
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
