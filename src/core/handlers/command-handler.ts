import type { Bot } from "grammy";
import type { AgentMode } from "../types.ts";
import { log } from "../logger.ts";
import { getSession, clearSession } from "../session-store.ts";
import { setMode } from "../mode-store.ts";
import { resolveMode, effectiveModels } from "../model-resolver.ts";
import type { HandlerDeps } from "./types.ts";
import { safeSend } from "./shared.ts";

const HELP_TEXT = [
  "Clawster — autonomous AI agent orchestrator.",
  "",
  "Each chat is routed to a project-specific Claude agent running in its own workspace.",
  "",
  "Commands:",
  "/help — Show this message",
  "/status — Show the agent serving this chat (incl. current mode + model)",
  "/convo — Conversation mode (Opus — orchestrator, default); /opus is an alias",
  "/plan — Planning mode (Fable — deep reasoning & analysis)",
  "/fable — Alias for /plan",
  "/build — Implementation mode (Sonnet — agentic coding); /sonnet is an alias",
  "/mode — Show the current mode, or set it: /mode convo | /mode plan | /mode build",
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
      { command: "convo", description: "Conversation mode (Opus — default); alias: /opus" },
      { command: "opus", description: "Alias for /convo (Opus — conversation mode)" },
      { command: "plan", description: "Planning mode (Fable — deep reasoning)" },
      { command: "fable", description: "Alias for /plan" },
      { command: "build", description: "Implementation mode (Sonnet — coding); alias: /sonnet" },
      { command: "sonnet", description: "Alias for /build (Sonnet — implementation mode)" },
      { command: "mode", description: "Show or set mode: /mode convo | /mode plan | /mode build" },
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

    const mode = await resolveMode(agent, topicId);
    const model = effectiveModels(agent)[mode];

    const lines = [
      `Agent: ${agent.name} (${agent.id})`,
      `Workspace: ${agent.workspace}`,
      `Mode: ${mode === "conversation" ? "conversation (Opus — orchestrator)" : mode === "planning" ? "planning (Fable — deep reasoning)" : "implementation (Sonnet — agentic coding)"}`,
      `Model: ${model}`,
      `Session messages: ${messageCount}`,
      `Session ID: ${sessionId ?? "(none — fresh session)"}`,
    ];
    if (lastActivity) lines.push(`Last activity: ${lastActivity}`);
    if (topicId) lines.push(`Topic: ${topicId}`);

    await safeSend(() => ctx.reply(lines.join("\n"), replyOpts));
  });

  // --- Model-mode commands ---
  //
  // A "mode" is per-chat (per topic in a forum group) and picks which model
  // line the agent drives: planning -> Fable (deep reasoning / plan authoring),
  // implementation -> Sonnet (agentic coding). The mode persists across
  // restarts via mode-store; the concrete model strings live in config.

  async function applyMode(ctx: any, mode: AgentMode): Promise<void> {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const topicId = ctx.message?.message_thread_id;
    const replyOpts = topicId ? { message_thread_id: topicId } : undefined;

    const agent = resolveAgent(chatId, isPrivate);
    if (!agent) {
      await safeSend(() =>
        ctx.reply("No agent is configured for this chat yet.", replyOpts),
      );
      return;
    }

    try {
      await setMode(agent.id, mode, topicId);
    } catch (err) {
      log.error("command", "Failed to set mode", { agentId: agent.id, error: String(err) });
      await safeSend(() => ctx.reply("Failed to set mode — check the logs.", replyOpts));
      return;
    }

    const model = effectiveModels(agent)[mode];
    const label =
      mode === "conversation"
        ? `Conversation mode on — ${agent.name} will use ${model} (orchestrator).`
        : mode === "planning"
        ? `Planning mode on — ${agent.name} will use ${model} for deep reasoning and plans.`
        : `Implementation mode on — ${agent.name} will use ${model} for agentic coding.`;
    await safeSend(() => ctx.reply(label, replyOpts));
  }

  bot.command("convo", (ctx) => applyMode(ctx, "conversation"));
  bot.command("opus", (ctx) => applyMode(ctx, "conversation"));
  bot.command("plan", (ctx) => applyMode(ctx, "planning"));
  bot.command("fable", (ctx) => applyMode(ctx, "planning"));
  bot.command("build", (ctx) => applyMode(ctx, "implementation"));
  bot.command("sonnet", (ctx) => applyMode(ctx, "implementation"));

  bot.command("mode", async (ctx) => {
    const arg = (ctx.match ?? "").toString().trim().toLowerCase();
    if (arg === "convo" || arg === "conversation" || arg === "chat" || arg === "opus") return applyMode(ctx, "conversation");
    if (arg === "plan" || arg === "planning" || arg === "fable") return applyMode(ctx, "planning");
    if (arg === "build" || arg === "implementation" || arg === "implement" || arg === "sonnet") {
      return applyMode(ctx, "implementation");
    }

    // No/unknown arg — report current mode.
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const topicId = ctx.message?.message_thread_id;
    const replyOpts = topicId ? { message_thread_id: topicId } : undefined;

    const agent = resolveAgent(chatId, isPrivate);
    if (!agent) {
      await safeSend(() => ctx.reply("No agent is configured for this chat yet.", replyOpts));
      return;
    }

    const mode = await resolveMode(agent, topicId);
    const model = effectiveModels(agent)[mode];
    const hint = arg && arg !== "" ? `Unknown mode "${arg}". ` : "";
    await safeSend(() =>
      ctx.reply(
        `${hint}Current mode: ${mode} (${model}).\nUse /convo, /plan, or /build (or /mode convo | /mode plan | /mode build) to switch.`,
        replyOpts,
      ),
    );
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
