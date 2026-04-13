/**
 * Phase 2 Migration: Merge OpenClaw workspace files into CLAUDE.md
 *
 * For each active agent, reads IDENTITY.md, SOUL.md, AGENTS.md, USER.md, TOOLS.md
 * and merges them into a single CLAUDE.md in the project root.
 * Skips agents that already have a CLAUDE.md.
 */

import { readFile, exists } from "fs/promises";
import { join } from "path";

interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
}

interface OrchestratorConfig {
  agents: AgentConfig[];
}

const SOURCE_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "TOOLS.md"] as const;

const SECTION_MAP: Record<string, string> = {
  "IDENTITY.md": "Identity",
  "SOUL.md": "Personality & Values",
  "AGENTS.md": "Session Rules",
  "USER.md": "About Chris",
  "TOOLS.md": "Tools & Environment",
};

/** Strip memory management sections from AGENTS.md content */
function stripMemorySections(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    // Detect memory-related headings (##, ###, etc.)
    if (/^#{1,4}\s+.*memory/i.test(line) || /^#{1,4}\s+.*heartbeat/i.test(line)) {
      skipping = true;
      continue;
    }
    // Stop skipping at the next heading of same or higher level
    if (skipping && /^#{1,4}\s+/.test(line) && !/memory/i.test(line) && !/heartbeat/i.test(line)) {
      skipping = false;
    }
    if (!skipping) {
      result.push(line);
    }
  }

  return result.join("\n").trim();
}

async function readOptionalFile(path: string): Promise<string | null> {
  try {
    if (await exists(path)) {
      const content = await readFile(path, "utf-8");
      return content.trim() || null;
    }
  } catch {
    // File unreadable, treat as missing
  }
  return null;
}

function buildClaudeMd(agentName: string, files: Record<string, string | null>): string {
  const sections: string[] = [`# ${agentName} — CLAUDE.md`];

  for (const sourceFile of SOURCE_FILES) {
    const heading = SECTION_MAP[sourceFile];
    let content = files[sourceFile];

    if (content && sourceFile === "AGENTS.md") {
      content = stripMemorySections(content);
      if (!content) content = null;
    }

    sections.push(`\n## ${heading}\n${content || "Not configured"}`);
  }

  sections.push(`
## Memory
You have access to Open Brain — a shared semantic memory system across all projects.
- To remember something: use the \`ob\` CLI: \`ob capture "thought text"\`
- To search memory: \`ob search "query"\`
- To browse recent: \`ob recent\`
For project-specific context, check the local memory/ directory.

## Communication
You are responding via Telegram. Keep responses concise and conversational.
Telegram supports basic markdown: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`.
Split long responses naturally. Avoid complex markdown tables.`);

  return sections.join("\n") + "\n";
}

async function main() {
  const configPath = join(
    import.meta.dir,
    "..",
    "config",
    "agents.json"
  );
  const config: OrchestratorConfig = JSON.parse(await readFile(configPath, "utf-8"));

  console.log(`Migrating ${config.agents.length} agent workspaces...\n`);

  let migrated = 0;
  let skipped = 0;

  for (const agent of config.agents) {
    const claudeMdPath = join(agent.workspace, "CLAUDE.md");

    // Check if workspace exists
    if (!(await exists(agent.workspace))) {
      console.log(`⏭  ${agent.id} (${agent.name}): workspace ${agent.workspace} does not exist, skipping`);
      skipped++;
      continue;
    }

    // Don't overwrite existing CLAUDE.md
    if (await exists(claudeMdPath)) {
      console.log(`⏭  ${agent.id} (${agent.name}): CLAUDE.md already exists, skipping`);
      skipped++;
      continue;
    }

    // Read all source files
    const files: Record<string, string | null> = {};
    const found: string[] = [];

    for (const sourceFile of SOURCE_FILES) {
      const content = await readOptionalFile(join(agent.workspace, sourceFile));
      files[sourceFile] = content;
      if (content) found.push(sourceFile);
    }

    // Build and write CLAUDE.md
    const claudeMd = buildClaudeMd(agent.name, files);
    await Bun.write(claudeMdPath, claudeMd);

    console.log(
      `✅ ${agent.id} (${agent.name}): created CLAUDE.md from [${found.join(", ") || "no source files"}]`
    );
    migrated++;
  }

  console.log(`\nDone. Migrated: ${migrated}, Skipped: ${skipped}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
