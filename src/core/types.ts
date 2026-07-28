export interface TopicConfig {
  name: string;
  /** Override the agent's workspace for this topic. */
  workspace?: string;
  /** Override the agent's knowledge base for this topic. */
  kb?: string;
  /**
   * This topic is not project work — the orchestrator skips the KB briefing.
   *
   * Zero Topics carries "Personal growth" and "Housing" beside "Clawster". All
   * route to the same agent, so without this a personal conversation would be
   * told to read kb-clawster before responding: a wasted turn, and a context
   * window filled with orchestrator internals it will never use.
   */
  noKb?: boolean;
}

/**
 * Which model tier an agent (or topic) is currently using:
 *  - "conversation"   — front-facing chat with the user (Opus); the orchestrator tier
 *  - "planning"       — deep reasoning / analysis / plan authoring (Fable)
 *  - "implementation" — agentic coding / executing a plan (Sonnet)
 * The concrete model string for each mode lives in ClawsterConfig.models,
 * with an optional per-agent override in AgentConfig.models.
 */
export type AgentMode = "conversation" | "planning" | "implementation";

/** Maps each mode to a `--model` value the SDK accepts (alias or full ID). */
export interface ModelsConfig {
  conversation: string;
  planning: string;
  implementation: string;
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
  inactivityTimeout?: number; // Per-agent inactivity timeout in seconds (default: 180)
  extraArgs?: Record<string, string | null>; // Extra CLI args passed to Claude Code (null = boolean flag, string = value flag)
  /**
   * Per-agent allowlist for MCP servers marked `restricted: true` in the
   * global MCP config. Non-restricted servers (e.g. Open Brain) are available
   * to every agent regardless. Restricted servers (e.g. Playwright, which
   * drives a logged-in browser) only attach to agents that explicitly list
   * them here. Undefined or empty array = no restricted servers granted.
   */
  mcpServers?: string[];
  /**
   * Default mode this agent starts in when no per-chat mode has been set via
   * /plan, /build, or /convo. Falls back to "conversation" when omitted.
   */
  defaultMode?: AgentMode;
  /**
   * Per-agent override of the fleet-wide ClawsterConfig.models mapping. Merged
   * over the global map, so an agent can pin (say) a different planning model
   * without redefining implementation. Omitted = use the fleet defaults.
   */
  models?: Partial<ModelsConfig>;
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
