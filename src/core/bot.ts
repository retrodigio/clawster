import { Bot } from "grammy";
import type { AgentConfig, MessageContext } from "./types.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { sendResponse } from "./message-sender.ts";
import { parseIntents, processIntents } from "./intent-parser.ts";
import { log } from "./logger.ts";
import { transcribe } from "./transcribe.ts";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

interface CreateBotOptions {
  botToken: string;
  allowedUserId: string;
  groqKey?: string;
  resolveAgent: (chatId: string, isPrivate: boolean) => AgentConfig | null;
  runner: { run(agent: AgentConfig, prompt: string, opts?: { topicId?: number }): Promise<string> };
  agentById: Map<string, AgentConfig>;
}

export function createBot({ botToken, allowedUserId, groqKey, resolveAgent, runner, agentById }: CreateBotOptions) {
  const bot = new Bot(botToken);

  // Auth middleware — only allowed user can interact
  bot.use(async (ctx, next) => {
    if (ctx.from?.id.toString() !== allowedUserId) {
      await ctx.reply("This bot is private.");
      return;
    }
    await next();
  });

  // Helper to resolve topic name from config or Telegram metadata
  function resolveTopicName(agent: AgentConfig, topicId: number | undefined, ctx: any): string | undefined {
    if (!topicId) return undefined;
    const fromConfig = agent.topics?.[topicId.toString()]?.name;
    if (fromConfig) return fromConfig;
    // Telegram sometimes includes topic info in the reply_to_message
    const replyMsg = ctx.message?.reply_to_message;
    if (replyMsg?.forum_topic_created?.name) {
      return replyMsg.forum_topic_created.name;
    }
    return undefined;
  }

  // Text message handler
  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";

    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    log.info("orchestrator", "Message received", { chatId, chatTitle, chatType: ctx.chat.type, isPrivate });

    const agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      log.warn("orchestrator", "No agent found for chat", { chatId });
      return;
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    log.info("orchestrator", "Routed to agent", { chatId, agentId: agent.id, topicId: topicId ?? null, topicName: topicName ?? null });

    const messageContext: MessageContext = {
      agentId: agent.id,
      chatId,
      topicId,
      topicName,
      isPrivate,
    };

    const prompt = buildPrompt(agent, ctx.message.text, messageContext);

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let placeholderMsgId: number | undefined;
    let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);

      // After 15 seconds, send a placeholder so the user knows we're still working
      const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
      placeholderTimeout = setTimeout(async () => {
        try {
          const msg = await ctx.reply("Thinking...", replyOpts);
          placeholderMsgId = msg.message_id;
        } catch {
          // Non-critical — just skip the placeholder
        }
      }, 15_000);

      const response = await runner.run(agent, prompt, { topicId });

      clearTimeout(placeholderTimeout);
      placeholderTimeout = undefined;

      const { clean, intents } = parseIntents(response);

      // Process intents in background
      if (intents.length > 0) {
        processIntents(intents).catch((err) => {
          log.error(agent.id, "Failed to process intents", { error: String(err) });
        });
      }

      // If we sent a placeholder and the response fits in one message, edit it in-place
      if (placeholderMsgId && clean.length <= 4000) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, placeholderMsgId, clean);
        } catch {
          // Edit failed — fall back to sending normally
          await sendResponse(ctx, clean, topicId);
        }
      } else {
        // Delete placeholder if it was sent, then send the full response
        if (placeholderMsgId) {
          await ctx.api.deleteMessage(ctx.chat.id, placeholderMsgId).catch(() => {});
        }
        await sendResponse(ctx, clean, topicId);
      }
    } catch (err) {
      log.error(agent.id, "Error handling message", { error: String(err) });
      await ctx.reply("Sorry, something went wrong processing your message.").catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
    }
  });

  // Photo handler
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      log.debug("orchestrator", "No agent found for chat", { chatId });
      return;
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = agent.topics?.[topicId?.toString() ?? ""]?.name;

    const messageContext: MessageContext = {
      agentId: agent.id,
      chatId,
      topicId,
      topicName,
      isPrivate,
    };

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let tempPath: string | undefined;
    let placeholderMsgId: number | undefined;
    let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      // Download highest-res photo (last in array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1]!;
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      tempPath = join(tmpdir(), `tg-photo-${Date.now()}.jpg`);
      await writeFile(tempPath, buffer);

      const caption = ctx.message.caption ?? "";
      const promptText = `[Image: ${tempPath}]\n\n${caption}`;
      const prompt = buildPrompt(agent, promptText, messageContext);

      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);

      // After 15 seconds, send a placeholder so the user knows we're still working
      const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
      placeholderTimeout = setTimeout(async () => {
        try {
          const msg = await ctx.reply("Thinking...", replyOpts);
          placeholderMsgId = msg.message_id;
        } catch {
          // Non-critical
        }
      }, 15_000);

      const result = await runner.run(agent, prompt, { topicId });

      clearTimeout(placeholderTimeout);
      placeholderTimeout = undefined;

      const { clean, intents } = parseIntents(result);

      if (intents.length > 0) {
        processIntents(intents).catch((err) => {
          log.error(agent.id, "Failed to process intents", { error: String(err) });
        });
      }

      if (placeholderMsgId && clean.length <= 4000) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, placeholderMsgId, clean);
        } catch {
          await sendResponse(ctx, clean, topicId);
        }
      } else {
        if (placeholderMsgId) {
          await ctx.api.deleteMessage(ctx.chat.id, placeholderMsgId).catch(() => {});
        }
        await sendResponse(ctx, clean, topicId);
      }
    } catch (err) {
      log.error(agent.id, "Error handling photo", { error: String(err) });
      await ctx.reply("Sorry, something went wrong processing your photo.").catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
      if (tempPath) {
        unlink(tempPath).catch(() => {});
      }
    }
  });

  // Voice message handler
  bot.on("message:voice", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      log.debug("orchestrator", "No agent found for chat", { chatId });
      return;
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    const messageContext: MessageContext = {
      agentId: agent.id,
      chatId,
      topicId,
      topicName,
      isPrivate,
    };

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let placeholderMsgId: number | undefined;
    let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;

    try {
      // Download voice file from Telegram
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Transcribe
      const transcription = await transcribe(buffer, groqKey ?? "");

      if (!transcription) {
        await ctx.reply("Couldn't transcribe voice message.");
        return;
      }

      log.info("orchestrator", "Voice transcribed", { chatId, agentId: agent.id, length: transcription.length });

      const promptText = `[Voice message]: ${transcription}`;
      const prompt = buildPrompt(agent, promptText, messageContext);

      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);

      // After 15 seconds, send a placeholder so the user knows we're still working
      const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
      placeholderTimeout = setTimeout(async () => {
        try {
          const msg = await ctx.reply("Thinking...", replyOpts);
          placeholderMsgId = msg.message_id;
        } catch {
          // Non-critical
        }
      }, 15_000);

      const result = await runner.run(agent, prompt, { topicId });

      clearTimeout(placeholderTimeout);
      placeholderTimeout = undefined;

      const { clean, intents } = parseIntents(result);

      if (intents.length > 0) {
        processIntents(intents).catch((err) => {
          log.error(agent.id, "Failed to process intents", { error: String(err) });
        });
      }

      if (placeholderMsgId && clean.length <= 4000) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, placeholderMsgId, clean);
        } catch {
          await sendResponse(ctx, clean, topicId);
        }
      } else {
        if (placeholderMsgId) {
          await ctx.api.deleteMessage(ctx.chat.id, placeholderMsgId).catch(() => {});
        }
        await sendResponse(ctx, clean, topicId);
      }
    } catch (err) {
      log.error(agent.id, "Error handling voice message", { error: String(err) });
      await ctx.reply("Sorry, something went wrong processing your voice message.").catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
    }
  });

  return bot;
}
