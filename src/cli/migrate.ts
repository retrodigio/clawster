import { Command } from "commander";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome, saveConfig, saveAgents } from "../core/config.ts";
import type { ClawsterConfig, AgentsConfig } from "../core/config.ts";

interface OldConfig {
  botToken?: string;
  allowedUserId?: string;
  claudePath?: string;
  openBrainPort?: number;
  maxGlobalConcurrent?: number;
  agents: Array<{
    id: string;
    name: string;
    workspace: string;
    telegramChatId: string;
    isDefault?: boolean;
    topics?: Record<string, { name: string }>;
    heartbeat?: {
      every: string;
      activeHours?: { start: string; end: string };
      target: "telegram";
      to: string;
    };
  }>;
}

function parseEnvFile(content: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    // Strip quotes
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    vars[key] = val;
  }
  return vars;
}

export const migrateCommand = new Command("migrate")
  .description("Migrate from old claude-orchestrator config to Clawster format")
  .action(async () => {
    const oldRoot = join(homedir(), "claude-orchestrator");
    const oldConfigPath = join(oldRoot, "config", "agents.json");
    const oldEnvPath = join(oldRoot, ".env");

    console.log("\n=== Clawster Migration ===\n");

    // Read old config
    if (!existsSync(oldConfigPath)) {
      console.error(`Old config not found at ${oldConfigPath}`);
      process.exit(1);
    }

    let oldConfig: OldConfig;
    try {
      oldConfig = JSON.parse(await readFile(oldConfigPath, "utf-8"));
    } catch (err) {
      console.error(`Failed to parse old config: ${err}`);
      process.exit(1);
      return;
    }

    // Read .env for bot token
    let envVars: Record<string, string> = {};
    if (existsSync(oldEnvPath)) {
      try {
        envVars = parseEnvFile(await readFile(oldEnvPath, "utf-8"));
        console.log("  Read .env file");
      } catch {
        console.log("  Could not read .env file, using config values");
      }
    }

    const botToken =
      envVars["TELEGRAM_BOT_TOKEN"] || envVars["BOT_TOKEN"] || oldConfig.botToken || "";
    const allowedUserId =
      envVars["TELEGRAM_USER_ID"] || envVars["ALLOWED_USER_ID"] || oldConfig.allowedUserId || "";

    if (!botToken) {
      console.error("No bot token found in .env or old config.");
      process.exit(1);
    }

    // Create new config
    const home = getClawsterHome();
    await mkdir(home, { recursive: true });
    await mkdir(join(home, "sessions"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });

    const config: ClawsterConfig = {
      botToken,
      allowedUserId,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      claudePath: oldConfig.claudePath || "claude",
      healthPort: 18800,
      maxConcurrent: oldConfig.maxGlobalConcurrent || 4,
    };

    await saveConfig(config);
    console.log("  Wrote config.json");

    // Convert agents
    const agents: AgentsConfig = {
      agents: oldConfig.agents.map((a) => ({
        id: a.id,
        name: a.name,
        workspace: a.workspace,
        telegramChatId: a.telegramChatId,
        ...(a.isDefault ? { isDefault: true } : {}),
        ...(a.topics ? { topics: a.topics } : {}),
        ...(a.heartbeat ? { heartbeat: a.heartbeat } : {}),
      })),
      unboundChatIds: [],
    };

    await saveAgents(agents);
    console.log(`  Wrote agents.json (${agents.agents.length} agents)`);

    console.log(`\nMigration complete. Config at ${home}`);
    console.log("\nMigrated agents:");
    for (const a of agents.agents) {
      console.log(`  - ${a.id} (${a.name})${a.isDefault ? " [default]" : ""}`);
    }
    console.log("\nRun 'clawster start' to begin.\n");
  });
