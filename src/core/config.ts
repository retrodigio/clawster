import { homedir } from "os";
import { join } from "path";
import { readFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { z } from "zod";
import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";

export function getClawsterHome(): string {
  return process.env.CLAWSTER_HOME || join(homedir(), ".clawster");
}

// --- Zod Schemas ---

export const ClawsterConfigSchema = z.object({
  botToken: z.string().min(1, "Bot token is required"),
  allowedUserId: z.string().min(1, "Allowed user ID is required"),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  claudePath: z.string().default("claude"),
  healthPort: z.number().int().min(1024).max(65535).default(18800),
  maxConcurrent: z.number().int().min(1).max(20).default(4),
  groqKey: z.string().optional(),
});

export const HeartbeatSchema = z.object({
  every: z.string().regex(/^\d+[mh]$/, "Must be like '30m' or '1h'"),
  activeHours: z.object({
    start: z.string().regex(/^\d{2}:\d{2}$/),
    end: z.string().regex(/^\d{2}:\d{2}$/),
  }).optional(),
  target: z.literal("telegram"),
  to: z.string(),
});

export const TaskSchema = z.object({
  name: z.string().min(1),
  schedule: z.string().min(1),
  prompt: z.string().min(1),
  telegramChatId: z.string().optional(),
  topicId: z.number().optional(),
  enabled: z.boolean().default(true),
});

export const AgentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  workspace: z.string().min(1),
  telegramChatId: z.string(),
  isDefault: z.boolean().optional(),
  topics: z.record(z.string(), z.object({ name: z.string() })).optional(),
  heartbeat: HeartbeatSchema.optional(),
  tasks: z.array(TaskSchema).optional(),
  inactivityTimeout: z.number().optional(),
  extraArgs: z.record(z.string(), z.nullable(z.string())).optional(),
});

export const AgentsConfigSchema = z.object({
  agents: z.array(AgentSchema),
  unboundChatIds: z.array(z.string()).default([]),
});

// --- Cron Validation ---

function isValidCronField(field: string): boolean {
  return /^(\*|\d+(-\d+)?)([,/](\*|\d+(-\d+)?))*$/.test(field);
}

function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  return fields.every(isValidCronField);
}

function validateCronExpressions(agents: AgentConfig[]): void {
  for (const agent of agents) {
    if (!agent.tasks) continue;
    for (const task of agent.tasks) {
      if (!isValidCronExpression(task.schedule)) {
        log.warn("config", `Agent '${agent.id}' task '${task.name}' has invalid cron expression: '${task.schedule}'`);
      }
    }
  }
}

function validateWorkspaces(agents: AgentConfig[]): void {
  for (const agent of agents) {
    if (!existsSync(agent.workspace)) {
      log.warn("config", `Agent '${agent.id}' workspace ${agent.workspace} does not exist`);
    }
  }
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((issue) => {
    const path = issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return `  - ${path}${issue.message}`;
  }).join("\n");
}

// --- Existing Interfaces (preserved for backwards compatibility) ---

export interface ClawsterConfig {
  botToken: string;
  allowedUserId: string;
  timezone: string;
  claudePath: string;
  healthPort: number;
  maxConcurrent: number;
  groqKey?: string;
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
  let rawConfig: Record<string, unknown> = {};
  try {
    rawConfig = JSON.parse(await readFile(configPath, "utf-8"));
  } catch {
    throw new Error(`Config not found at ${configPath}. Run 'clawster init' first.`);
  }

  // Apply env overrides — secrets prefer env vars, fall back to config.json with warning
  if (process.env.CLAWSTER_BOT_TOKEN) {
    rawConfig.botToken = process.env.CLAWSTER_BOT_TOKEN;
  } else if (rawConfig.botToken) {
    log.warn("config", "Bot token found in config.json — migrate to CLAWSTER_BOT_TOKEN env var for security");
  }

  if (process.env.CLAWSTER_GROQ_KEY) {
    rawConfig.groqKey = process.env.CLAWSTER_GROQ_KEY;
  } else if (rawConfig.groqKey) {
    log.warn("config", "Groq key found in config.json — migrate to CLAWSTER_GROQ_KEY env var for security");
  }

  if (process.env.CLAWSTER_USER_ID) rawConfig.allowedUserId = process.env.CLAWSTER_USER_ID;
  if (process.env.CLAWSTER_TIMEZONE) rawConfig.timezone = process.env.CLAWSTER_TIMEZONE;

  // Validate config with Zod
  let config: ClawsterConfig;
  try {
    config = ClawsterConfigSchema.parse(rawConfig) as ClawsterConfig;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`Config validation failed (${configPath}):\n${formatZodError(err)}`);
    }
    throw err;
  }

  // Load agents.json
  const agentsPath = join(home, "agents.json");
  let rawAgentsData: unknown;
  try {
    rawAgentsData = JSON.parse(await readFile(agentsPath, "utf-8"));
  } catch {
    throw new Error(`Agents config not found at ${agentsPath}. Run 'clawster init' first.`);
  }

  // Validate agents with Zod
  let rawAgents: AgentsConfig;
  try {
    rawAgents = AgentsConfigSchema.parse(rawAgentsData) as AgentsConfig;
  } catch (err) {
    if (err instanceof z.ZodError) {
      throw new Error(`Agents config validation failed (${agentsPath}):\n${formatZodError(err)}`);
    }
    throw err;
  }

  // Post-parse validation warnings
  validateWorkspaces(rawAgents.agents);
  validateCronExpressions(rawAgents.agents);

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
  // Strip secrets from disk — they should live in env vars only
  const { botToken, groqKey, ...safeConfig } = config;
  await Bun.write(join(home, "config.json"), JSON.stringify(safeConfig, null, 2));
}

/** Load or generate the API token for web API authentication. */
export async function loadApiToken(): Promise<string> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  const tokenPath = join(home, "api-token");
  try {
    const token = await readFile(tokenPath, "utf-8");
    if (token.trim()) return token.trim();
  } catch { /* file doesn't exist yet */ }
  const token = crypto.randomUUID();
  await Bun.write(tokenPath, token);
  return token;
}
