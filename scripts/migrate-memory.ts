/**
 * Phase 2 Migration: Ingest historical memory files into Open Brain
 *
 * For each active agent, reads MEMORY.md and memory/*.md files,
 * splits by ## headings, filters trivial content, and captures
 * each meaningful section as a thought via `ob capture`.
 */

import { readFile, readdir, exists } from "fs/promises";
import { join } from "path";

interface AgentConfig {
  id: string;
  name: string;
  workspace: string;
}

interface OrchestratorConfig {
  agents: AgentConfig[];
}

const TRIVIAL_PATTERNS = [
  /^heartbeat:\s*all\s+systems?\s+normal/i,
  /^heartbeat/i,
  /^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}/,  // bare timestamps
  /^---+$/,
];

function isTrivial(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 50) return true;

  // Check if every non-empty line matches a trivial pattern
  const lines = trimmed.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return true;

  // If the heading line removed leaves <50 chars of real content
  const withoutHeading = lines.slice(1).join("\n").trim();
  if (withoutHeading.length < 50) return true;

  // Check if it's all heartbeat/trivial lines
  const nonTrivialLines = lines.filter(
    (line) => !TRIVIAL_PATTERNS.some((p) => p.test(line.trim()))
  );
  if (nonTrivialLines.length === 0) return true;

  return false;
}

/** Split markdown content by ## headings, keeping heading with its content */
function splitBySections(content: string): string[] {
  const sections: string[] = [];
  const lines = content.split("\n");
  let current: string[] = [];

  for (const line of lines) {
    if (line.startsWith("## ") && current.length > 0) {
      sections.push(current.join("\n").trim());
      current = [line];
    } else {
      current.push(line);
    }
  }

  if (current.length > 0) {
    const text = current.join("\n").trim();
    if (text) sections.push(text);
  }

  return sections;
}

async function captureThought(text: string, agentId: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["ob", "capture", text, "--source", `migration:${agentId}`], {
      stdout: "ignore",
      stderr: "pipe",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`    ob capture failed (exit ${exitCode}): ${stderr.trim()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error(`    ob capture error: ${err}`);
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processFile(
  filePath: string,
  agentId: string,
  agentName: string,
  label: string
): Promise<number> {
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return 0;
  }

  const sections = splitBySections(content);
  let captured = 0;

  for (const section of sections) {
    if (isTrivial(section)) continue;

    const thought = `[${agentName}] ${section}`;
    const ok = await captureThought(thought, agentId);
    if (ok) captured++;
    await delay(200);
  }

  return captured;
}

async function main() {
  const configPath = join(import.meta.dir, "..", "config", "agents.json");
  const config: OrchestratorConfig = JSON.parse(await readFile(configPath, "utf-8"));

  console.log(`Migrating memory for ${config.agents.length} agents...\n`);

  let totalThoughts = 0;

  for (const agent of config.agents) {
    // Check if workspace exists
    if (!(await exists(agent.workspace))) {
      console.log(`${agent.id}: workspace does not exist, skipping`);
      continue;
    }

    let memoryMdCount = 0;
    let dailyCount = 0;

    // 1. Process MEMORY.md
    const memoryMdPath = join(agent.workspace, "MEMORY.md");
    if (await exists(memoryMdPath)) {
      memoryMdCount = await processFile(memoryMdPath, agent.id, agent.name, "MEMORY.md");
    }

    // 2. Process memory/ directory
    const memoryDir = join(agent.workspace, "memory");
    if (await exists(memoryDir)) {
      try {
        const files = await readdir(memoryDir);
        const mdFiles = files.filter((f) => f.endsWith(".md")).sort();

        for (const file of mdFiles) {
          const filePath = join(memoryDir, file);
          const count = await processFile(filePath, agent.id, agent.name, file);
          dailyCount += count;
        }
      } catch (err) {
        console.error(`  ${agent.id}: error reading memory/ directory: ${err}`);
      }
    }

    const agentTotal = memoryMdCount + dailyCount;
    totalThoughts += agentTotal;

    console.log(
      `${agent.id}: captured ${memoryMdCount} thoughts from MEMORY.md, ${dailyCount} thoughts from daily files`
    );
  }

  console.log(`\nDone. Total thoughts captured: ${totalThoughts}`);
}

main().catch((err) => {
  console.error("Migration failed:", err);
  process.exit(1);
});
