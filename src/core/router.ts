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
