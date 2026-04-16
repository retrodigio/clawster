import type { AgentConfig } from "../types.ts";
import type { ActivityStatus } from "../agent-runner.ts";

export interface HandlerDeps {
  botToken: string;
  resolveAgent: (chatId: string, isPrivate: boolean) => AgentConfig | null;
  runner: {
    run(agent: AgentConfig, prompt: string, opts?: { topicId?: number }): Promise<string>;
    runStreaming(agent: AgentConfig, prompt: string, onUpdate: (textSoFar: string) => void, opts?: { topicId?: number; timeout?: number; onActivity?: (status: ActivityStatus) => void }): Promise<{ text: string; sessionId: string | null }>;
  };
  agentById: Map<string, AgentConfig>;
  allowedUserId: string;
  groqKey?: string;
}
