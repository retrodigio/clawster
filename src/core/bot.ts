import { Bot } from "grammy";
import type { AgentConfig, MessageContext } from "./types.ts";
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
    runStreaming(agent: AgentConfig, prompt: string, onUpdate: (textSoFar: string) => void, opts?: { topicId?: number; timeout?: number }): Promise<{ text: string; sessionId: string | null }>;
  };
  agentById: Map<string, AgentConfig>;
}

export function createBot({ botToken, allowedUserId, groqKey, resolveAgent, runner, agentById }: CreateBotOptions) {
  const bot = new Bot(botToken);

  // Track chats currently in onboarding so we don't trigger discovery multiple times
  const onboardingChats = new Set<string>();
  // Track chats that the user declined to create projects for — route to Zero
  const declinedChats = new Set<string>();

  // Auth middleware — only allowed user can interact
  bot.use(async (ctx, next) => {
    if (ctx.from?.id.toString() !== allowedUserId) {
      await ctx.reply("This bot is private.");
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

      const onUpdate = async (textSoFar: string) => {
        if (!textSoFar || textSoFar.length < 200 || streamStoppedEditing) return;

        // If text is too long for a single message, stop editing — we'll send chunked at the end
        if (textSoFar.length > 4000) {
          streamStoppedEditing = true;
          return;
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

      const { text: response } = await runner.runStreaming(agent, prompt, onUpdate, { topicId });

      const { clean, intents } = parseIntents(response);

      // Process intents in background
      if (intents.length > 0) {
        processIntents(intents).catch((err) => {
          log.error(agent.id, "Failed to process intents", { error: String(err) });
        });
      }

      // Final delivery: update streaming message or send full response
      if (streamMsgId && clean.length <= 4000) {
        // Edit to final clean text (intents stripped, etc.)
        try {
          await ctx.api.editMessageText(ctx.chat.id, streamMsgId, clean);
        } catch {
          await sendResponse(ctx, clean, topicId);
        }
      } else {
        // Delete partial message if it exists, send full response with chunking
        if (streamMsgId) {
          await ctx.api.deleteMessage(ctx.chat.id, streamMsgId).catch(() => {});
        }
        await sendResponse(ctx, clean, topicId);
      }
    } catch (err) {
      log.error(agent.id, "Error handling message", { error: String(err) });
      await ctx.reply("Sorry, something went wrong processing your message.").catch(() => {});
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
      await ctx.reply("Sorry, something went wrong processing your voice message.").catch(() => {});
    } finally {
      if (typingInterval) clearInterval(typingInterval);
      if (placeholderTimeout) clearTimeout(placeholderTimeout);
    }
  });

  return bot;
}
