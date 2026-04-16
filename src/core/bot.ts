import { Bot } from "grammy";
import type { AgentConfig, MessageContext } from "./types.ts";
import type { ActivityStatus } from "./agent-runner.ts";
import { buildPrompt } from "./prompt-builder.ts";
import { sendResponse } from "./message-sender.ts";
import { parseIntents, processIntents } from "./intent-parser.ts";
import { log } from "./logger.ts";
import { transcribe } from "./transcribe.ts";
import { registerTopic, getRouterState } from "./router.ts";
import { findMatchingProject, createAgentFromMatch, createNewProject } from "./discovery.ts";
import { writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

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

/** Safely send/edit Telegram messages — never throw on API errors. */
async function safeSend(fn: () => Promise<any>): Promise<any> {
  try {
    return await fn();
  } catch (err: any) {
    const desc = err?.description ?? String(err);
    log.warn("telegram", "API call failed (non-fatal)", { error: desc });
    return null;
  }
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

  // Track chats currently in onboarding so we don't trigger discovery multiple times
  const onboardingChats = new Set<string>();
  // Track chats that the user declined to create projects for — route to Zero
  const declinedChats = new Set<string>();

  // Auth middleware — only allowed user can interact
  bot.use(async (ctx, next) => {
    if (ctx.from?.id.toString() !== allowedUserId) {
      await safeSend(() => ctx.reply("This bot is private."));
      return;
    }
    await next();
  });

  /**
   * Handle onboarding: send message to Zero, parse response for intents,
   * and either create the project or continue the conversation.
   * Returns the response text to send to the user in the group.
   */
  async function handleOnboarding(chatId: string, chatTitle: string, userMessage: string, isFirstMessage: boolean): Promise<string> {
    const { defaultAgent: zero } = getRouterState();

    let prompt: string;
    if (isFirstMessage) {
      prompt = `[NEW GROUP DETECTED — ONBOARDING]

A message arrived from Telegram group "${chatTitle}" (chat ID: ${chatId}).
No matching project was found in ~/projects/.

User's message: "${userMessage}"

Help Chris set up a project for this group. Ask briefly:
1. What is this project about?
2. Confirm the project name (suggest: "${chatTitle}")

When you have enough info, include this block in your response:

[CREATE_PROJECT]
name: ProjectName
description: Brief description
[/CREATE_PROJECT]

If Chris doesn't want a project for this group, include: [SKIP_PROJECT]

Keep it conversational — this is Telegram.`;
    } else {
      prompt = `[ONBOARDING CONTINUED — "${chatTitle}" (${chatId})]

Chris replied: "${userMessage}"

Continue the onboarding conversation. When ready, include the structured block:

[CREATE_PROJECT]
name: ProjectName
description: Brief description
[/CREATE_PROJECT]

Or if Chris declines: [SKIP_PROJECT]`;
    }

    const { text } = await runner.runStreaming(zero, prompt, () => {});
    return text;
  }

  // Helper to resolve topic name from config or Telegram metadata
  function resolveTopicName(agent: AgentConfig, topicId: number | undefined, ctx: any): string | undefined {
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

  // Text message handler
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
          const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();

          // Already declined — route to Zero silently
          if (declinedChats.has(chatId)) {
            agent = defaultAgent;
          } else {
            // Step 1: Try name-matching against ~/projects/
            const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);

            if (match) {
              log.info("discovery", "Name-matched group to project", {
                groupName: chatTitle,
                project: match.path,
                score: match.score,
              });
              agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
              agentById.set(agent.id, agent);
              await sendResponse(ctx, `Linked this group to project "${agent.name}" (${agent.workspace}). Processing your message...`, topicId);
            } else {
              // Step 2: No match — onboard via Zero
              const isFirstMessage = !onboardingChats.has(chatId);
              onboardingChats.add(chatId);

              log.info("discovery", "Onboarding via Zero", { chatId, groupName: chatTitle, isFirstMessage });

              const zeroResponse = await handleOnboarding(chatId, chatTitle ?? "unknown", ctx.message.text, isFirstMessage);

              // Check for CREATE_PROJECT intent
              const createMatch = zeroResponse.match(/\[CREATE_PROJECT\]\s*\n?name:\s*(.+)\n?description:\s*(.+)\n?\[\/CREATE_PROJECT\]/i);
              const skipMatch = zeroResponse.includes("[SKIP_PROJECT]");

              if (createMatch) {
                const projectName = createMatch[1]!.trim();
                const description = createMatch[2]!.trim();
                agent = await createNewProject(chatId, projectName, agentsConfig, chatIdToAgent, description);
                agentById.set(agent.id, agent);
                onboardingChats.delete(chatId);

                const cleanResponse = zeroResponse.replace(/\[CREATE_PROJECT\][\s\S]*?\[\/CREATE_PROJECT\]/i, "").trim();
                await sendResponse(ctx, cleanResponse || `Project "${projectName}" created at ~/projects/${agent.id}/. You're live!`, topicId);
                // Don't process the original message as a normal query — onboarding is done
                return;
              }

              if (skipMatch) {
                declinedChats.add(chatId);
                onboardingChats.delete(chatId);
                const cleanResponse = zeroResponse.replace("[SKIP_PROJECT]", "").trim();
                await sendResponse(ctx, cleanResponse || "Got it, routing messages here to the default agent.", topicId);
                return;
              }

              // Zero asked a follow-up — send to user and wait for next message
              const cleanResponse = zeroResponse
                .replace(/\[CREATE_PROJECT\][\s\S]*?\[\/CREATE_PROJECT\]/i, "")
                .replace("[SKIP_PROJECT]", "")
                .trim();
              if (cleanResponse) {
                await sendResponse(ctx, cleanResponse, topicId);
              }
              return;
            }
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

  // Photo handler
  bot.on("message:photo", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    let agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      // For photos, just try name-match — don't start full onboarding
      const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();
      const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);
      if (match) {
        agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
        agentById.set(agent.id, agent);
      } else {
        agent = defaultAgent;
      }
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

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
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your photo."));
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
    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    let agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      // For voice, just try name-match — don't start full onboarding
      const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();
      const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);
      if (match) {
        agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
        agentById.set(agent.id, agent);
      } else {
        agent = defaultAgent;
      }
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

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
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your voice message."));
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
    }
  });

  // Document/file handler
  bot.on("message:document", async (ctx) => {
    const chatId = ctx.chat.id.toString();
    const isPrivate = ctx.chat.type === "private";
    const chatTitle = "title" in ctx.chat ? ctx.chat.title : "DM";
    let agent = resolveAgent(chatId, isPrivate);

    if (!agent) {
      // For documents, just try name-match — don't start full onboarding
      const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();
      const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);
      if (match) {
        agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
        agentById.set(agent.id, agent);
      } else {
        agent = defaultAgent;
      }
    }

    const topicId = ctx.message.message_thread_id;
    const topicName = resolveTopicName(agent, topicId, ctx);

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

    let typingInterval: ReturnType<typeof setInterval> | undefined;
    let tempPath: string | undefined;
    let placeholderMsgId: number | undefined;
    let placeholderTimeout: ReturnType<typeof setTimeout> | undefined;

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

      const fileUrl = `https://api.telegram.org/file/bot${botToken}/${file.file_path}`;
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
      log.error(agent.id, "Error handling document", { error: String(err) });
      await safeSend(() => ctx.reply("Sorry, something went wrong processing your document."));
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
      if (tempPath) {
        unlink(tempPath).catch(() => {});
      }
    }
  });

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
