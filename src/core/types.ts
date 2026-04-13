export interface TopicConfig {
  name: string;
}

export interface HeartbeatConfig {
  every: string;
  activeHours?: { start: string; end: string };
  target: "telegram";
  to: string;
}

export interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
  telegramChatId: string;
  isDefault?: boolean;
  topics?: Record<string, TopicConfig>;
  heartbeat?: HeartbeatConfig;
}

export interface OrchestratorConfig {
  botToken: string;
  allowedUserId: string;
  claudePath: string;
  openBrainPort: number;
  maxGlobalConcurrent: number;
  agents: AgentConfig[];
}

export interface AgentSession {
  sessionId: string | null;
  lastActivity: string;
  lastHeartbeat: string | null;
  messageCount: number;
}

export interface MessageContext {
  agentId: string;
  chatId: string;
  topicId?: number;
  topicName?: string;
  isPrivate: boolean;
}
