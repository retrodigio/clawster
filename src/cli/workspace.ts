import { Command } from "commander";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";

const SOURCE_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "TOOLS.md"] as const;

const SECTION_MAP: Record<string, string> = {
  "IDENTITY.md": "Identity",
  "SOUL.md": "Personality & Values",
  "AGENTS.md": "Session Rules",
  "USER.md": "About the User",
  "TOOLS.md": "Tools & Environment",
};

function stripMemorySections(content: string): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let skipping = false;

  for (const line of lines) {
    if (/^#{1,4}\s+.*memory/i.test(line) || /^#{1,4}\s+.*heartbeat/i.test(line)) {
      skipping = true;
      continue;
    }
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
    if (existsSync(path)) {
      const content = await readFile(path, "utf-8");
      return content.trim() || null;
    }
  } catch {
    // Unreadable
  }
  return null;
}

function buildClaudeMd(
  name: string,
  files: Record<string, string | null>
): string {
  const sections: string[] = [`# ${name} — CLAUDE.md`];

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

export const workspaceCommand = new Command("workspace").description(
  "Manage agent workspaces"
);

workspaceCommand
  .command("init <path>")
  .description("Initialize a workspace with CLAUDE.md")
  .option("--name <name>", "Agent name for the CLAUDE.md header", "Agent")
  .option("--merge", "Merge existing IDENTITY.md/SOUL.md files into CLAUDE.md")
  .action(async (workspacePath: string, opts: { name: string; merge?: boolean }) => {
    const claudeMdPath = join(workspacePath, "CLAUDE.md");

    if (existsSync(claudeMdPath) && !opts.merge) {
      console.log(`CLAUDE.md already exists at ${claudeMdPath}. Use --merge to overwrite with merged content.`);
      return;
    }

    const files: Record<string, string | null> = {};
    const found: string[] = [];

    if (opts.merge) {
      for (const sourceFile of SOURCE_FILES) {
        const content = await readOptionalFile(join(workspacePath, sourceFile));
        files[sourceFile] = content;
        if (content) found.push(sourceFile);
      }
    } else {
      for (const sourceFile of SOURCE_FILES) {
        files[sourceFile] = null;
      }
    }

    const claudeMd = buildClaudeMd(opts.name, files);
    await Bun.write(claudeMdPath, claudeMd);

    if (opts.merge && found.length > 0) {
      console.log(`CLAUDE.md created from: ${found.join(", ")}`);
    } else {
      console.log(`CLAUDE.md template created at ${claudeMdPath}`);
    }
  });
