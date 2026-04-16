import type { AgentConfig } from "../types.ts";
import { log } from "../logger.ts";
import { getRouterState } from "../router.ts";
import { findMatchingProject, createAgentFromMatch, createNewProject } from "../discovery.ts";
import { sendResponse } from "../message-sender.ts";
import type { HandlerDeps } from "./types.ts";

// Track chats currently in onboarding so we don't trigger discovery multiple times
const onboardingChats = new Set<string>();
// Track chats that the user declined to create projects for — route to Zero
const declinedChats = new Set<string>();

export function isDeclined(chatId: string): boolean {
  return declinedChats.has(chatId);
}

/**
 * Handle onboarding: send message to Zero, parse response for intents,
 * and either create the project or continue the conversation.
 * Returns the response text to send to the user in the group.
 */
async function handleOnboarding(
  chatId: string,
  chatTitle: string,
  userMessage: string,
  isFirstMessage: boolean,
  runner: HandlerDeps["runner"],
): Promise<string> {
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

/**
 * Attempt auto-discovery for an unknown chat. Returns the resolved agent if found,
 * or null if still in onboarding flow (response already sent to user).
 */
export async function handleDiscovery(
  ctx: any,
  chatId: string,
  chatTitle: string,
  userMessage: string,
  topicId: number | undefined,
  deps: HandlerDeps,
): Promise<AgentConfig | null> {
  const { chatIdToAgent, agentsConfig, defaultAgent } = getRouterState();

  // Already declined — route to Zero silently
  if (declinedChats.has(chatId)) {
    return defaultAgent;
  }

  // Step 1: Try name-matching against ~/projects/
  const match = findMatchingProject(chatTitle ?? "", agentsConfig.agents);

  if (match) {
    log.info("discovery", "Name-matched group to project", {
      groupName: chatTitle,
      project: match.path,
      score: match.score,
    });
    const agent = await createAgentFromMatch(chatId, chatTitle ?? match.dirName, match.path, agentsConfig, chatIdToAgent);
    deps.agentById.set(agent.id, agent);
    await sendResponse(ctx, `Linked this group to project "${agent.name}" (${agent.workspace}). Processing your message...`, topicId);
    return agent;
  }

  // Step 2: No match — onboard via Zero
  const isFirstMessage = !onboardingChats.has(chatId);
  onboardingChats.add(chatId);

  log.info("discovery", "Onboarding via Zero", { chatId, groupName: chatTitle, isFirstMessage });

  const zeroResponse = await handleOnboarding(chatId, chatTitle ?? "unknown", userMessage, isFirstMessage, deps.runner);

  // Check for CREATE_PROJECT intent
  const createMatch = zeroResponse.match(/\[CREATE_PROJECT\]\s*\n?name:\s*(.+)\n?description:\s*(.+)\n?\[\/CREATE_PROJECT\]/i);
  const skipMatch = zeroResponse.includes("[SKIP_PROJECT]");

  if (createMatch) {
    const projectName = createMatch[1]!.trim();
    const description = createMatch[2]!.trim();
    const agent = await createNewProject(chatId, projectName, agentsConfig, chatIdToAgent, description);
    deps.agentById.set(agent.id, agent);
    onboardingChats.delete(chatId);

    const cleanResponse = zeroResponse.replace(/\[CREATE_PROJECT\][\s\S]*?\[\/CREATE_PROJECT\]/i, "").trim();
    await sendResponse(ctx, cleanResponse || `Project "${projectName}" created at ~/projects/${agent.id}/. You're live!`, topicId);
    return null; // Signal: onboarding complete, don't process as normal query
  }

  if (skipMatch) {
    declinedChats.add(chatId);
    onboardingChats.delete(chatId);
    const cleanResponse = zeroResponse.replace("[SKIP_PROJECT]", "").trim();
    await sendResponse(ctx, cleanResponse || "Got it, routing messages here to the default agent.", topicId);
    return null;
  }

  // Zero asked a follow-up — send to user and wait for next message
  const cleanResponse = zeroResponse
    .replace(/\[CREATE_PROJECT\][\s\S]*?\[\/CREATE_PROJECT\]/i, "")
    .replace("[SKIP_PROJECT]", "")
    .trim();
  if (cleanResponse) {
    await sendResponse(ctx, cleanResponse, topicId);
  }
  return null;
}
