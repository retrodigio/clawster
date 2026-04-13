import type { AgentConfig } from "./types.ts";

let chatIdToAgent: Map<string, AgentConfig>;
let defaultAgent: AgentConfig;
let unboundIds: Set<string>;

export function initRouter(
  chatMap: Map<string, AgentConfig>,
  defAgent: AgentConfig,
  unboundChatIds: Set<string>,
): void {
  chatIdToAgent = chatMap;
  defaultAgent = defAgent;
  unboundIds = unboundChatIds;
}

export function resolveAgent(chatId: string, isPrivate: boolean): AgentConfig | null {
  if (isPrivate || unboundIds.has(chatId)) {
    return defaultAgent;
  }
  return chatIdToAgent.get(chatId) ?? null;
}
