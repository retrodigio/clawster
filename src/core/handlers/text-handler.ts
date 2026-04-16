import type { Bot } from "grammy";
import type { MessageContext } from "../types.ts";
import type { ActivityStatus } from "../agent-runner.ts";
import { buildPrompt } from "../prompt-builder.ts";
import { sendResponse } from "../message-sender.ts";
import { parseIntents, processIntents } from "../intent-parser.ts";
import { log } from "../logger.ts";
import { registerTopic } from "../router.ts";
import type { HandlerDeps } from "./types.ts";
import { safeSend, resolveTopicName } from "./shared.ts";
import { handleDiscovery } from "./onboarding-handler.ts";

export function registerTextHandler(bot: Bot, deps: HandlerDeps): void {
  const { resolveAgent, runner, agentById } = deps;

  bot.on("message:text", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";

    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    log.info("orchestrator", "Message received", { chatId, chatTitle, chatType: ctx.chat.type, isPrivate });

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
    let streamMsgId: number | undefined;
    let streamStoppedEditing = false;
    try {
      await ctx.replyWithChatAction("typing");
      typingInterval = setInterval(() => {
        ctx.replyWithChatAction("typing").catch(() => {});
      }, 5000);

      const replyOpts = topicId ? { message_thread_id: topicId } : undefined;
      let statusMsgId: number | undefined;

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
            const msg = await ctx.reply(textSoFar, replyOpts);
            streamMsgId = msg.message_id;
          } else {
            await ctx.api.editMessageText(ctx.chat.id, streamMsgId, textSoFar);
          }
        } catch {
          // Telegram edit failed — skip this update, try next time
        }
      };

      const onActivity = async (status: ActivityStatus) => {
        // Don't send status updates if we already have streaming text
        if (streamMsgId) return;

        const elapsed = status.elapsed;
        const minutes = Math.floor(elapsed / 60);
        const timeStr = minutes > 0 ? `${minutes}m ${elapsed % 60}s` : `${elapsed}s`;
        const statusText = `${status.detail} (${timeStr})`;

        if (statusMsgId) {
          await safeSend(() => ctx.api.editMessageText(ctx.chat.id, statusMsgId!, statusText));
        } else {
          const msg = await safeSend(() => ctx.reply(statusText, replyOpts));
          if (msg) statusMsgId = msg.message_id;
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
      if (streamMsgId && clean.length <= 4000) {
        try {
          await ctx.api.editMessageText(ctx.chat.id, streamMsgId, clean);
        } catch {
          await sendResponse(ctx, clean, topicId);
        }
      } else {
        if (streamMsgId) {
          await safeSend(() => ctx.api.deleteMessage(ctx.chat.id, streamMsgId!));
        }
        await sendResponse(ctx, clean, topicId);
      }
    } catch (err) {
      log.error(agent.id, "Error handling message", { error: String(err) });
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your message."));
    } finally {
      if (typingInterval) clearInterval(typingInterval);
    }
  });
}
