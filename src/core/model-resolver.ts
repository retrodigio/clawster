import type { AgentConfig, AgentMode, ModelsConfig } from "./types.ts";
import { getConfig } from "./config-store.ts";
import { getMode } from "./mode-store.ts";

/**
 * Resolves the effective mode + model for an agent/chat, layering three sources
 * (highest precedence first):
 *   1. per-chat mode set via /convo, /plan, or /build (mode-store)
 *   2. agent.defaultMode
 *   3. "conversation" (Opus — orchestrator tier for front-facing chats)
 * The model string comes from the fleet-wide config.models, with any per-agent
 * agent.models override merged on top.
 *
 * Kept in one place so the runner (which actually launches the query) and the
 * Telegram /mode & /status commands (which report it) never diverge.
 */

export function effectiveModels(agent: AgentConfig): ModelsConfig {
  const base = getConfig().config.models;
  return {
    conversation: agent.models?.conversation ?? base.conversation,
    planning: agent.models?.planning ?? base.planning,
    implementation: agent.models?.implementation ?? base.implementation,
  };
}

export async function resolveMode(agent: AgentConfig, topicId?: number): Promise<AgentMode> {
  return (await getMode(agent.id, topicId)) ?? agent.defaultMode ?? "conversation";
}

export async function resolveAgentModel(agent: AgentConfig, topicId?: number): Promise<string> {
  const mode = await resolveMode(agent, topicId);
  return effectiveModels(agent)[mode];
}
