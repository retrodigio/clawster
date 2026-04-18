import type { Bot } from "grammy";
import type { MessageContext } from "../types.ts";
import type { ActivityStatus } from "../agent-runner.ts";
import { buildPrompt } from "../prompt-builder.ts";
import { sendResponse } from "../message-sender.ts";
import { parseIntents, processIntents } from "../intent-parser.ts";
import { log } from "../logger.ts";
import { registerTopic } from "../router.ts";
import type { HandlerDeps } from "./types.ts";
import { safeSend, safeReact, resolveTopicName } from "./shared.ts";
import { handleDiscovery } from "./onboarding-handler.ts";

export function registerTextHandler(bot: Bot, deps: HandlerDeps): void {
  const { resolveAgent, runner, agentById } = deps;

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    // Correlation ID for duplicate-response debugging. Every send/edit/delete
    // is tagged with this so we can replay a single request's full lifecycle.
    const reqId = crypto.randomUUID().slice(0, 8);

    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    log.info("orchestrator", "Message received", { reqId, chatId, chatTitle, chatType: ctx.chat.type, isPrivate, msgId: ctx.message.message_id });

    // Instant acknowledgement: mark the message as seen
    await safeReact(ctx, "👀");

    let agent = resolveAgent(chatId, isPrivate);

    // Unknown chat — try auto-discovery
    if (!agent) {
      const topicId = ctx.message.message_thread_id;

      try {
        await ctx.replyWithChatAction("typing");
        const typingInterval = setInterval(() => {
          ctx.replyWithChatAction("typing").catch(() => {});
        }, 5000);

        try {
          const result = await handleDiscovery(ctx, chatId, chatTitle ?? "unknown", ctx.message.text, topicId, deps);

          if (result) {
            agent = result;
          } else {
            // Onboarding handled the response — done for this message
            return;
          }
        } finally {
          clearInterval(typingInterval);
        }
      } catch (err) {
        log.error("discovery", "Auto-discovery failed", { error: String(err), chatId });
        return;
      }
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

    // Auto-register new topics for known agents
    if (topicId && topicName && !agent.topics?.[topicId.toString()]) {
      await registerTopic(agent, topicId, topicName);
    }

    log.info("orchestrator", "Routed to agent", { reqId, chatId, agentId: agent.id, topicId: topicId ?? null, topicName: topicName ?? null });

    const messageContext: MessageContext = {
      agentId: agent.id,
      chatId,
      topicId,
      topicName,
      isPrivate,
    };

    const prompt = buildPrompt(agent, ctx.message.text, messageContext);

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let streamMsgId: number | undefined;
    let streamMsgCreating = false;
    let streamStoppedEditing = false;
    try {
      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);

      const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
      let statusMsgId: number | undefined;
      let statusMsgCreating = false;

      const onUpdate = async (textSoFar: string) => {
        if (!textSoFar || textSoFar.length < 200 || streamStoppedEditing) return;

        // If text is too long for a single message, stop editing — we'll send chunked at the end
        if (textSoFar.length > 4000) {
          streamStoppedEditing = true;
          return;
        }

        // If we had a status message, delete it now that we have real text
        if (statusMsgId) {
          await safeSend(() => ctx.api.deleteMessage(ctx.chat.id, statusMsgId!));
          statusMsgId = undefined;
        }

        try {
          if (!streamMsgId) {
            // Race guard: only one concurrent caller creates the streaming message
            if (streamMsgCreating) return;
            streamMsgCreating = true;
            try {
              log.info("send", "reply: stream create", { reqId, source: "onUpdate", chatId, len: textSoFar.length });
              const msg = await ctx.reply(textSoFar, replyOpts);
              streamMsgId = msg?.message_id;
              log.info("send", "reply: stream created", { reqId, source: "onUpdate", chatId, messageId: streamMsgId, replyResultType: typeof msg });
            } finally {
              streamMsgCreating = false;
            }
          } else {
            log.info("send", "edit: stream update", { reqId, source: "onUpdate", chatId, messageId: streamMsgId, len: textSoFar.length });
            await ctx.api.editMessageText(ctx.chat.id, streamMsgId, textSoFar);
          }
        } catch (err: any) {
          log.warn("send", "stream send/edit failed", { reqId, source: "onUpdate", error: err?.description ?? String(err) });
        }
      };

      const onActivity = async (status: ActivityStatus) => {
        // Don't send status updates if we already have streaming text (or are creating one)
        if (streamMsgId || streamMsgCreating) return;

        const elapsed = status.elapsed;
        const minutes = Math.floor(elapsed / 60);
        const timeStr = minutes > 0 ? `${minutes}m ${elapsed % 60}s` : `${elapsed}s`;
        const statusText = `${status.detail} (${timeStr})`;

        if (statusMsgId) {
          await safeSend(() => ctx.api.editMessageText(ctx.chat.id, statusMsgId!, statusText));
        } else {
          // Race guard: only one concurrent caller creates the status message
          if (statusMsgCreating) return;
          statusMsgCreating = true;
          try {
            const msg = await safeSend(() => ctx.reply(statusText, replyOpts));
            if (msg) statusMsgId = msg.message_id;
          } finally {
            statusMsgCreating = false;
          }
        }
      };

      const { text: response } = await runner.runStreaming(agent, prompt, onUpdate, { topicId, onActivity });

      const { clean, intents } = parseIntents(response);

      // Process intents in background
      if (intents.length > 0) {
        processIntents(intents).catch((err) => {
          log.error(agent.id, "Failed to process intents", { error: String(err) });
        });
      }

      // Clean up status message if still showing
      if (statusMsgId) {
        await safeSend(() => ctx.api.deleteMessage(ctx.chat.id, statusMsgId!));
      }

      // Final delivery: update streaming message or send full response
      log.info("send", "final delivery entry", { reqId, chatId, hasStreamMsg: !!streamMsgId, streamMsgId, streamMsgCreating, cleanLen: clean.length });
      if (streamMsgId && clean.length <= 4000) {
        try {
          log.info("send", "edit: final", { reqId, source: "final", chatId, messageId: streamMsgId, len: clean.length });
          await ctx.api.editMessageText(ctx.chat.id, streamMsgId, clean);
        } catch (err: any) {
          const desc = (err?.description ?? String(err)).toLowerCase();
          // Benign: the streamed message already shows this exact text (or was deleted).
          // User already sees the correct response — don't duplicate it with a fallback send.
          if (
            desc.includes("message is not modified") ||
            desc.includes("message to edit not found") ||
            desc.includes("message can't be edited")
          ) {
            log.info("send", "final edit no-op (content unchanged or target gone)", { reqId, chatId, messageId: streamMsgId });
          } else {
            log.warn("send", "final edit failed — falling back to sendResponse", { reqId, error: err?.description ?? String(err) });
            log.info("send", "reply: sendResponse (fallback)", { reqId, source: "final-fallback", chatId, len: clean.length });
            await sendResponse(ctx, clean, topicId);
          }
        }
      } else {
        if (streamMsgId) {
          log.info("send", "delete: stream msg (too long for edit)", { reqId, chatId, messageId: streamMsgId });
          await safeSend(() => ctx.api.deleteMessage(ctx.chat.id, streamMsgId!));
        }
        log.info("send", "reply: sendResponse", { reqId, source: "final-send", chatId, len: clean.length });
        await sendResponse(ctx, clean, topicId);
      }

      await safeReact(ctx, "✅");
    } catch (err) {
      log.error(agent.id, "Error handling message", { error: String(err) });
      await safeReact(ctx, "❌");
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your message."));
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  });
}
