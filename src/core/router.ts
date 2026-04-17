import type { AgentConfig } from "./types.ts";
import { log } from "./logger.ts";
import { saveAgents } from "./config.ts";
import type { AgentsConfig } from "./config.ts";

let chatIdToAgent: Map<string, AgentConfig>;
let defaultAgent: AgentConfig;
let unboundIds: Set<string>;
let agentsConfig: AgentsConfig;

export function initRouter(
  chatMap: Map<string, AgentConfig>,
  defAgent: AgentConfig,
  unboundChatIds: Set<string>,
  agents: AgentsConfig,
): void {
  chatIdToAgent = chatMap;
  defaultAgent = defAgent;
  unboundIds = unboundChatIds;
  agentsConfig = agents;
}

export function resolveAgent(chatId: string, isPrivate: boolean): AgentConfig | null {
  if (isPrivate || unboundIds.has(chatId)) {
    return defaultAgent;
  }
  return chatIdToAgent.get(chatId) ?? null;
}

/** Expose internals for discovery module. */
export function getRouterState() {
  return { chatIdToAgent, defaultAgent, unboundIds, agentsConfig };
}

/**
 * Unbind a chat from its agent mapping. Called when Telegram returns a
 * `permanent_chat` error (bot kicked, blocked, chat deleted) for a chat that
 * was mapped to an agent. The agent itself is preserved — only the dead
 * chat/heartbeat pointers are cleared so we stop trying to reach it.
 *
 * Returns true if we actually unbound something, false if the chatId wasn't
 * mapped (so callers can avoid spamming the log).
 */
export async function unbindDeadChat(chatId: string): Promise<boolean> {
  const agent = chatIdToAgent?.get(chatId);
  if (!agent) return false;

  // Remove runtime mapping so subsequent messages from this chat aren't routed
  // to the now-detached agent.
  chatIdToAgent.delete(chatId);

  // Clear the pointer on the in-memory agent so heartbeats don't fire.
  if (agent.telegramChatId === chatId) {
    agent.telegramChatId = "";
  }
  if (agent.heartbeat?.to === chatId) {
    agent.heartbeat = undefined;
  }

  // Mirror the change into the persisted config and save.
  const persisted = agentsConfig.agents.find((a) => a.id === agent.id);
  if (persisted) {
    if (persisted.telegramChatId === chatId) {
      persisted.telegramChatId = "";
    }
    if (persisted.heartbeat?.to === chatId) {
      persisted.heartbeat = undefined;
    }
    try {
      await saveAgents(agentsConfig);
    } catch (err) {
      log.error("router", "Failed to persist unbind", { agentId: agent.id, chatId, error: String(err) });
      // Runtime is already unbound — return true anyway so we stop retrying.
    }
  }

  log.warn("router", "Unbound dead chat from agent", {
    agentId: agent.id,
    agentName: agent.name,
    chatId,
    reason: "permanent_chat",
  });

  return true;
}

/**
 * Auto-register a new forum topic for an existing agent.
 * Updates the agent's topics map in memory and persists to agents.json.
 */
export async function registerTopic(agent: AgentConfig, topicId: number, topicName: string): Promise<void> {
  if (!agent.topics) {
    agent.topics = {};
  }

  if (agent.topics[topicId.toString()]) return;

  agent.topics[topicId.toString()] = { name: topicName };

  // Update the persisted config
  const persisted = agentsConfig.agents.find((a) => a.id === agent.id);
  if (persisted) {
    if (!persisted.topics) persisted.topics = {};
    persisted.topics[topicId.toString()] = { name: topicName };
    await saveAgents(agentsConfig);
  }

  log.info("router", "Auto-registered topic", {
    agentId: agent.id,
    topicId,
    topicName,
  });
}
