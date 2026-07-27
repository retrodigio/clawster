import { homedir } from "os";
import { join } from "path";
import { readFile, writeFile, mkdir, chmod, rename } from "fs/promises";
import { existsSync } from "fs";
import { z } from "zod";
import { log } from "./logger.ts";
import type { AgentConfig, ModelsConfig } from "./types.ts";

export function getClawsterHome(): string {
  return process.env.CLAWSTER_HOME || join(homedir(), ".clawster");
}

// --- Secrets env file (~/.clawster/env) ---
//
// Durable home for secrets (CLAWSTER_BOT_TOKEN, CLAWSTER_GROQ_KEY, ...) so they
// survive plist regeneration by `clawster daemon install`. Plain KEY=VALUE
// lines, written 0600. Real environment variables always take precedence.

export function getEnvFilePath(): string {
  return join(getClawsterHome(), "env");
}

/** Parse ~/.clawster/env into a map. Returns {} when the file doesn't exist. */
export async function readEnvFile(): Promise<Record<string, string>> {
  let content: string;
  try {
    content = await readFile(getEnvFilePath(), "utf-8");
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    // Allow optionally quoted values
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Apply the env file to process.env without overriding real environment variables. */
export async function applyEnvFile(): Promise<void> {
  const vars = await readEnvFile();
  for (const [key, value] of Object.entries(vars)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

/** Add or update a single entry in ~/.clawster/env (created 0600). */
export async function saveEnvVar(key: string, value: string): Promise<void> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  const existing = await readEnvFile();
  existing[key] = value;
  const lines = [
    "# Clawster secrets — loaded by the orchestrator and merged into the daemon",
    "# config by `clawster daemon install`. Keep this file private (0600).",
    ...Object.entries(existing).map(([k, v]) => `${k}=${v}`),
    "",
  ];
  await writeFile(getEnvFilePath(), lines.join("\n"), { mode: 0o600 });
  await chmod(getEnvFilePath(), 0o600).catch(() => {});
}

// --- Zod Schemas ---

// Model per mode.
//   conversation   -> opus            (front-facing orchestrator chat)
//   planning       -> claude-fable-5  (deep reasoning / plan authoring)
//   implementation -> sonnet          (agentic coding / subagent work)
// NOTE: `opus` and `sonnet` are CLI aliases and refresh automatically. `fable`
// is pinned to its full model ID because SDK 0.2.x does not recognize the
// `fable` alias — it will pass validation on the CLI but fail through the SDK
// path with "issue with the selected model (fable)". Upgrade to SDK 0.3.x or
// later before switching this back to the bare alias.
export const DEFAULT_MODELS = {
  conversation: "opus",
  planning: "claude-fable-5",
  implementation: "sonnet",
} as const;

export const ModelsConfigSchema = z.object({
  conversation: z.string().default(DEFAULT_MODELS.conversation),
  planning: z.string().default(DEFAULT_MODELS.planning),
  implementation: z.string().default(DEFAULT_MODELS.implementation),
});

export const ClawsterConfigSchema = z.object({
  botToken: z.string().min(1, "Bot token is required — set CLAWSTER_BOT_TOKEN in the environment or add CLAWSTER_BOT_TOKEN=... to ~/.clawster/env"),
  allowedUserId: z.string().min(1, "Allowed user ID is required"),
  timezone: z.string().default(Intl.DateTimeFormat().resolvedOptions().timeZone),
  claudePath: z.string().default("claude"),
  healthPort: z.number().int().min(1024).max(65535).default(18800),
  maxConcurrent: z.number().int().min(1).max(20).default(4),
  groqKey: z.string().optional(),
  models: ModelsConfigSchema.default(DEFAULT_MODELS),
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
  // Per-agent allowlist for MCP servers marked `restricted: true` in
  // config/mcp-servers.json. See AgentConfig.mcpServers for rationale.
  mcpServers: z.array(z.string()).optional(),
  // Model-mode overrides. defaultMode sets which mode a fresh chat starts in;
  // models overrides the fleet-wide model mapping for this agent only.
  defaultMode: z.enum(["conversation", "planning", "implementation"]).optional(),
  models: z.object({
    conversation: z.string().optional(),
    planning: z.string().optional(),
    implementation: z.string().optional(),
  }).optional(),
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
  models: ModelsConfig;
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

  // Secrets live in ~/.clawster/env (real env vars still win)
  await applyEnvFile();

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

  // Validate config with Zod. Default a missing token to "" so the failure
  // surfaces the actionable min(1) message instead of a bare type error.
  if (rawConfig.botToken === undefined) rawConfig.botToken = "";
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

/** Write a JSON file atomically (tmp + rename) so a crash mid-write can't corrupt it. */
async function writeJsonAtomic(path: string, data: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

export async function saveAgents(agents: AgentsConfig): Promise<void> {
  // Never persist a fleet config the next startup would refuse to load —
  // loadConfig() throws on schema violations, so an invalid write here would
  // brick the daemon hours later with no obvious cause.
  AgentsConfigSchema.parse(agents);
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  await writeJsonAtomic(join(home, "agents.json"), agents);
}

export async function saveConfig(config: ClawsterConfig): Promise<void> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  // Strip secrets from disk — they live in ~/.clawster/env or real env vars
  const { botToken, groqKey, ...safeConfig } = config;
  await writeJsonAtomic(join(home, "config.json"), safeConfig);
}

/** Load or generate the API token for web API authentication. */
export async function loadApiToken(): Promise<string> {
  const home = getClawsterHome();
  await mkdir(home, { recursive: true });
  // The token grants agent execution — keep the directory and file owner-only.
  await chmod(home, 0o700).catch(() => {});
  const tokenPath = join(home, "api-token");
  try {
    const token = await readFile(tokenPath, "utf-8");
    if (token.trim()) {
      await chmod(tokenPath, 0o600).catch(() => {});
      return token.trim();
    }
  } catch { /* file doesn't exist yet */ }
  const token = crypto.randomUUID();
  await writeFile(tokenPath, token, { mode: 0o600 });
  return token;
}
