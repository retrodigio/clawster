import type { Bot } from "grammy";
import { log } from "../logger.ts";
import { getSession, clearSession } from "../session-store.ts";
import type { HandlerDeps } from "./types.ts";
import { safeSend } from "./shared.ts";

const HELP_TEXT = [
  "Clawster — autonomous AI agent orchestrator.",
  "",
  "Each chat is routed to a project-specific Claude agent running in its own workspace.",
  "",
  "Commands:",
  "/help — Show this message",
  "/status — Show the agent serving this chat",
  "/reset — Clear the current conversation session",
  "",
  "Send any text, photo, or voice message to talk to the agent.",
].join("\n");

export function registerCommandHandler(bot: Bot, deps: HandlerDeps): void {
  const { resolveAgent } = deps;

  // Register the command menu so Telegram clients show `/` autocomplete.
  bot.api
    .setMyCommands([
      { command: "help", description: "Show available commands" },
      { command: "status", description: "Show the agent serving this chat" },
      { command: "reset", description: "Clear the current conversation session" },
    ])
    .catch((err: any) => {
      log.warn("telegram", "setMyCommands failed (non-fatal)", {
        error: err?.description ?? String(err),
      });
    });

  bot.command("help", async (ctx) => {
    const topicId = ctx.message?.message_thread_id;
    const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
    await safeSend(() => ctx.reply(HELP_TEXT, replyOpts));
  });

  bot.command("status", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const topicId = ctx.message?.message_thread_id;
    const replyOpts = topicId ? { message_thread_id: topicId } : undefined;

    const agent = resolveAgent(chatId, isPrivate);
    if (!agent) {
      await safeSend(() =>
        ctx.reply(
          "No agent is configured for this chat yet. Send a message to start onboarding.",
          replyOpts,
        ),
      );
      return;
    }

    let messageCount = 0;
    let sessionId: string | null = null;
    let lastActivity: string | null = null;
    try {
      const session = await getSession(agent.id, topicId);
      messageCount = session.messageCount;
      sessionId = session.sessionId;
      lastActivity = session.lastActivity;
    } catch (err) {
      log.warn("command", "Failed to load session for /status", {
        agentId: agent.id,
        error: String(err),
      });
    }

    const lines = [
      `Agent: ${agent.name} (${agent.id})`,
      `Workspace: ${agent.workspace}`,
      `Session messages: ${messageCount}`,
      `Session ID: ${sessionId ?? "(none — fresh session)"}`,
    ];
    if (lastActivity) lines.push(`Last activity: ${lastActivity}`);
    if (topicId) lines.push(`Topic: ${topicId}`);

    await safeSend(() => ctx.reply(lines.join("\n"), replyOpts));
  });

  bot.command("reset", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const topicId = ctx.message?.message_thread_id;
    const replyOpts = topicId ? { message_thread_id: topicId } : undefined;

    const agent = resolveAgent(chatId, isPrivate);
    if (!agent) {
      await safeSend(() =>
        ctx.reply("No agent is configured for this chat — nothing to reset.", replyOpts),
      );
      return;
    }

    try {
      await clearSession(agent.id, topicId);
      log.info("command", "Session cleared via /reset", {
        agentId: agent.id,
        topicId: topicId ?? null,
      });
      await safeSend(() =>
        ctx.reply(
          `Session cleared for ${agent.name}. The next message starts a fresh conversation.`,
          replyOpts,
        ),
      );
    } catch (err) {
      log.error("command", "Failed to clear session", {
        agentId: agent.id,
        error: String(err),
      });
      await safeSend(() =>
        ctx.reply("Failed to clear session — check the logs.", replyOpts),
      );
    }
  });
}
