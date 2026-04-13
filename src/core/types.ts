export interface TopicConfig {
  name: string;
}

export interface HeartbeatConfig {
  every: string;
  activeHours?: { start: string; end: string };
  target: "telegram";
  to: string;
}

export interface TaskConfig {
  name: string;
  schedule: string;       // Cron expression: "0 9 * * *" (9am daily), "*/30 * * * *" (every 30m), etc.
  prompt: string;         // The prompt to send to claude -p (can be a /skill-name)
  telegramChatId?: string; // Override: send output to this chat (defaults to agent's chat)
  topicId?: number;       // Optional: send to specific forum topic within the group
  enabled?: boolean;      // Default true. Set false to disable without removing.
}

export interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
  telegramChatId: string;
  isDefault?: boolean;
  topics?: Record<string, TopicConfig>;
  heartbeat?: HeartbeatConfig;
  tasks?: TaskConfig[];
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
