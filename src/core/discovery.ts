import { readdirSync, statSync, existsSync } from "fs";
import { join, basename } from "path";
import { homedir } from "os";
import { log } from "./logger.ts";
import { saveAgents } from "./config.ts";
import type { AgentsConfig } from "./config.ts";
import type { AgentConfig } from "./types.ts";

const PROJECTS_DIR = join(homedir(), "projects");

/**
 * Normalize a name for fuzzy matching:
 * lowercase, strip non-alphanumeric, collapse whitespace.
 */
function normalize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Score how well a Telegram group name matches a project directory name.
 * Returns 0 (no match) to 1 (exact match).
 */
function matchScore(groupName: string, dirName: string): number {
  const gn = normalize(groupName);
  const dn = normalize(dirName);

  // Exact match after normalization
  if (gn === dn) return 1.0;

  // One contains the other
  if (gn.includes(dn) || dn.includes(gn)) return 0.8;

  // Check if all words in the dir name appear in the group name or vice versa
  const gWords = gn.split(" ").filter(Boolean);
  const dWords = dn.split(" ").filter(Boolean);
  const gInD = gWords.filter((w) => dWords.some((d) => d.includes(w) || w.includes(d)));
  const dInG = dWords.filter((w) => gWords.some((g) => g.includes(w) || w.includes(g)));

  if (dWords.length > 0 && dInG.length === dWords.length) return 0.7;
  if (gWords.length > 0 && gInD.length === gWords.length) return 0.7;

  return 0;
}

/**
 * Try to find a project directory that matches the given Telegram group name.
 * Excludes directories that are already bound to an agent.
 * Returns the best match above the threshold, or null.
 */
export function findMatchingProject(
  groupName: string,
  existingAgents: AgentConfig[],
): { path: string; dirName: string; score: number } | null {
  if (!existsSync(PROJECTS_DIR)) return null;

  const boundWorkspaces = new Set(existingAgents.map((a) => a.workspace));

  let best: { path: string; dirName: string; score: number } | null = null;

  try {
    const entries = readdirSync(PROJECTS_DIR);
    for (const entry of entries) {
      const fullPath = join(PROJECTS_DIR, entry);
      // Skip non-directories, -repo suffixed dirs, and already-bound workspaces
      if (!statSync(fullPath).isDirectory()) continue;
      if (entry.endsWith("-repo")) continue;
      if (boundWorkspaces.has(fullPath)) continue;

      const score = matchScore(groupName, entry);
      if (score >= 0.7 && (!best || score > best.score)) {
        best = { path: fullPath, dirName: entry, score };
      }
    }
  } catch {
    log.warn("discovery", "Could not scan projects directory", { path: PROJECTS_DIR });
  }

  return best;
}

/**
 * Create and persist a new agent from a matched project directory.
 * Returns the new agent config.
 */
export async function createAgentFromMatch(
  chatId: string,
  groupName: string,
  projectPath: string,
  agentsConfig: AgentsConfig,
  chatIdToAgent: Map<string, AgentConfig>,
): Promise<AgentConfig> {
  const dirName = basename(projectPath);
  const id = dirName.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  const agent: AgentConfig = {
    id,
    name: groupName,
    workspace: projectPath,
    telegramChatId: chatId,
  };

  agentsConfig.agents.push(agent);
  await saveAgents(agentsConfig);

  // Update in-memory routing
  chatIdToAgent.set(chatId, agent);

  log.info("discovery", "Auto-created agent from project match", {
    agentId: id,
    groupName,
    workspace: projectPath,
    chatId,
  });

  return agent;
}

/**
 * Create a brand new project directory with a basic CLAUDE.md.
 * Returns the new agent config.
 */
export async function createNewProject(
  chatId: string,
  groupName: string,
  agentsConfig: AgentsConfig,
  chatIdToAgent: Map<string, AgentConfig>,
  description?: string,
): Promise<AgentConfig> {
  const dirName = groupName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "");
  const projectPath = join(PROJECTS_DIR, dirName);
  const id = dirName;

  // Create project directory
  const { mkdirSync, writeFileSync } = await import("fs");
  mkdirSync(projectPath, { recursive: true });

  // Generate a starter CLAUDE.md
  const claudeMd = `# ${groupName} — CLAUDE.md

## Identity
You are ${groupName}, an AI agent managed by Clawster.
${description ? `\n${description}\n` : ""}
## Communication
You are responding via Telegram. Keep responses concise and conversational.
Telegram supports basic markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`.

## Memory
You have access to Open Brain — a shared semantic memory system across all projects.
- To remember something: \`ob capture "thought text"\`
- To search memory: \`ob search "query"\`
- To browse recent: \`ob recent\`
`;

  writeFileSync(join(projectPath, "CLAUDE.md"), claudeMd);

  // Initialize git
  try {
    Bun.spawnSync(["git", "init"], { cwd: projectPath, stdout: "ignore", stderr: "ignore" });
  } catch {
    // Non-critical
  }

  const agent: AgentConfig = {
    id,
    name: groupName,
    workspace: projectPath,
    telegramChatId: chatId,
  };

  agentsConfig.agents.push(agent);
  await saveAgents(agentsConfig);
  chatIdToAgent.set(chatId, agent);

  log.info("discovery", "Created new project and agent", {
    agentId: id,
    groupName,
    workspace: projectPath,
    chatId,
  });

  return agent;
}
