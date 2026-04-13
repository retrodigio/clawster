import { homedir } from "os";
import { join } from "path";
import { readFile, mkdir } from "fs/promises";
import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";

export function getClawsterHome(): string {
  return process.env.CLAWSTER_HOME || join(homedir(), ".clawster");
}

export interface ClawsterConfig {
  botToken: string;
  allowedUserId: string;
  timezone: string;
  claudePath: string;
  healthPort: number;
  maxConcurrent: number;
}

export interface AgentsConfig {
  agents: AgentConfig[];
  unboundChatIds: string[];
}

export interface LoadedConfig {
  config: ClawsterConfig;
  agents: AgentsConfig;
  chatIdToAgent: Map<string, AgentConfig>;
  agentById: Map<string, AgentConfig>;
  defaultAgent: AgentConfig;
}

export async function loadConfig(): Promise<LoadedConfig> {
  const home = getClawsterHome();

  // Load config.json
  const configPath = join(home, "config.json");
  let rawConfig: Partial<ClawsterConfig> = {};
  try {
    rawConfig = JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    throw new Error(`Config not found at ${configPath}. Run 'clawster init' first.`);
  }

  // Apply env overrides
  const config: ClawsterConfig = {
    botToken: process.env.CLAWSTER_BOT_TOKEN || rawConfig.botToken || "",
    allowedUserId: process.env.CLAWSTER_USER_ID || rawConfig.allowedUserId || "",
    timezone: process.env.CLAWSTER_TIMEZONE || rawConfig.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    claudePath: rawConfig.claudePath || "claude",
    healthPort: rawConfig.healthPort || 18800,
    maxConcurrent: rawConfig.maxConcurrent || 4,
  };

  if (!config.botToken) throw new Error("No bot token. Set in config.json or CLAWSTER_BOT_TOKEN env var.");
  if (!config.allowedUserId) throw new Error("No user ID. Set in config.json or CLAWSTER_USER_ID env var.");

  // Load agents.json
  const agentsPath = join(home, "agents.json");
  let rawAgents: AgentsConfig = { agents: [], unboundChatIds: [] };
  try {
    rawAgents = JSON.parse(await readFile(agentsPath, "utf-8"));
  } catch {
    throw new Error(`Agents config not found at ${agentsPath}. Run 'clawster init' first.`);
  }

  // Build maps
  const chatIdToAgent = new Map<string, AgentConfig>();
  const agentById = new Map<string, AgentConfig>();
  let defaultAgent: AgentConfig | undefined;

  for (const agent of rawAgents.agents) {
    agentById.set(agent.id, agent);
    if (agent.telegramChatId) chatIdToAgent.set(agent.telegramChatId, agent);
    if (agent.isDefault) defaultAgent = agent;
  }

  if (!defaultAgent) throw new Error("No default agent (set isDefault: true).");

  log.info("system", "Config loaded", { agents: rawAgents.agents.length, defaultAgent: defaultAgent.id });

  return { config, agents: rawAgents, chatIdToAgent, agentById, defaultAgent };
}

export async function saveAgents(agents: AgentsConfig): Promise<void> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  await Bun.write(join(home, "agents.json"), JSON.stringify(agents, null, 2));
}

export async function saveConfig(config: ClawsterConfig): Promise<void> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  await Bun.write(join(home, "config.json"), JSON.stringify(config, null, 2));
}
