import type { Bot } from "grammy";
import type { AgentConfig, MessageContext } from "../types.ts";
import { buildPrompt } from "../prompt-builder.ts";
import { sendResponse } from "../message-sender.ts";
import { parseIntents, processIntents } from "../intent-parser.ts";
import { log } from "../logger.ts";
import { registerTopic, getRouterState } from "../router.ts";
import { transcribe } from "../transcribe.ts";
import { findMatchingProject, createAgentFromMatch } from "../discovery.ts";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { HandlerDeps } from "./types.ts";
import { safeSend, safeReact, resolveTopicName } from "./shared.ts";

/**
 * Resolve agent for media messages, handling the async agent creation case.
 * For media, we try name-match only (no full onboarding). Falls back to default agent.
 */
async function resolveMediaAgentAsync(
  chatId: string,
  isPrivate: boolean,
  chatTitle: string,
  deps: HandlerDeps,
): Promise<AgentConfig> {
  let agent = deps.resolveAgent(chatId, isPrivate);
  if (!agent) {
    const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();
    const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);
    if (match) {
      agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
      deps.agentById.set(agent.id, agent);
    } else {
      agent = defaultAgent;
    }
  }
  return agent;
}

/**
 * Shared logic for handling media messages (photo, voice, document).
 * Manages typing indicator, placeholder message, running query, and sending response.
 */
async function handleMediaMessage(
  ctx: any,
  agent: AgentConfig,
  promptText: string,
  topicId: number | undefined,
  topicName: string | undefined,
  mediaType: string,
  deps: HandlerDeps,
): Promise<void> {
  const chatId = ctx.chat.id.toString();
  const isPrivate = ctx.chat.type === "private";

  if (topicId && topicName && !agent.topics?.[topicId.toString()]) {
    await registerTopic(agent, topicId, topicName);
  }

  const messageContext: MessageContext = {
    agentId: agent.id,
    chatId,
    topicId,
    topicName,
    isPrivate,
  };

  const prompt = buildPrompt(agent, promptText, messageContext);

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
        // Non-critical
      }
    }, 15_000);

    const result = await deps.runner.run(agent, prompt, { topicId });

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

    await safeReact(ctx, "✅");
  } catch (err) {
    log.error(agent.id, `Error handling ${mediaType}`, { error: String(err) });
    await safeReact(ctx, "❌");
    await safeSend(() => ctx.reply(`Sorry, something went wrong processing your ${mediaType}.`));
  } finally {
    if (typingInterval) clearInterval(typingInterval);
    if (placeholderTimeout) clearTimeout(placeholderTimeout);
  }
}

export function registerMediaHandlers(bot: Bot, deps: HandlerDeps): void {
  // Photo handler
  bot.on("message:photo", async (ctx) => {
    await safeReact(ctx, "👀");
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const chatTitle = ("title" in ctx.chat ? ctx.chat.title : "DM") ?? "DM";
    const agent = await resolveMediaAgentAsync(chatId, isPrivate, chatTitle, deps);

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    let tempPath: string | undefined;
    try {
      // Download highest-res photo (last in array)
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1]!;
      const file = await ctx.api.getFile(largest.file_id);
      const fileUrl = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;

      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());
      tempPath = join(tmpdir(), `tg-photo-${Date.now()}.jpg`);
      await writeFile(tempPath, buffer);

      const caption = ctx.message.caption ?? "";
      const promptText = `[Image: ${tempPath}]\n\n${caption}`;

      await handleMediaMessage(ctx, agent, promptText, topicId, topicName, "photo", deps);
    } finally {
      if (tempPath) {
        unlink(tempPath).catch(() => {});
      }
    }
  });

  // Voice message handler
  bot.on("message:voice", async (ctx) => {
    await safeReact(ctx, "👀");
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const chatTitle = ("title" in ctx.chat ? ctx.chat.title : "DM") ?? "DM";
    const agent = await resolveMediaAgentAsync(chatId, isPrivate, chatTitle, deps);

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    try {
      // Download voice file from Telegram
      const file = await ctx.getFile();
      const fileUrl = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      const buffer = Buffer.from(await response.arrayBuffer());

      // Transcribe
      const transcription = await transcribe(buffer, deps.groqKey ?? "");

      if (!transcription) {
        await ctx.reply("Couldn't transcribe voice message.");
        return;
      }

      log.info("orchestrator", "Voice transcribed", { chatId, agentId: agent.id, length: transcription.length });

      const promptText = `[Voice message]: ${transcription}`;

      await handleMediaMessage(ctx, agent, promptText, topicId, topicName, "voice message", deps);
    } catch (err) {
      log.error(agent.id, "Error handling voice message", { error: String(err) });
      await safeReact(ctx, "❌");
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your voice message."));
    }
  });

  // Document/file handler
  bot.on("message:document", async (ctx) => {
    await safeReact(ctx, "👀");
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const chatTitle = ("title" in ctx.chat ? ctx.chat.title : "DM") ?? "DM";
    const agent = await resolveMediaAgentAsync(chatId, isPrivate, chatTitle, deps);

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    let tempPath: string | undefined;
    try {
      const doc = ctx.message.document;
      const originalName = doc.file_name ?? `document-${Date.now()}`;
      const mimeType = doc.mime_type ?? "application/octet-stream";

      // Download file from Telegram
      const file = await ctx.api.getFile(doc.file_id);
      if (!file.file_path) {
        await safeSend(() => ctx.reply("Could not download the file — Telegram did not return a file path."));
        return;
      }

      const fileUrl = `https://api.telegram.org/file/bot${deps.botToken}/${file.file_path}`;
      const response = await fetch(fileUrl);
      if (!response.ok) {
        await safeSend(() => ctx.reply("Failed to download the file from Telegram."));
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      tempPath = join(tmpdir(), `tg-doc-${Date.now()}-${originalName}`);
      await writeFile(tempPath, buffer);

      log.info("orchestrator", "Document received", { chatId, agentId: agent.id, filename: originalName, mimeType, size: buffer.length });

      const caption = ctx.message.caption ?? "";
      const promptText = `[Document: ${originalName} (${mimeType})] saved to: ${tempPath}\n\n${caption}`;

      await handleMediaMessage(ctx, agent, promptText, topicId, topicName, "document", deps);
    } finally {
      if (tempPath) {
        unlink(tempPath).catch(() => {});
      }
    }
  });
}
