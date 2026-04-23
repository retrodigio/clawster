import { Command } from "commander";
import { readFile, copyFile } from "fs/promises";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const SOURCE_FILES = ["IDENTITY.md", "SOUL.md", "AGENTS.md", "USER.md", "TOOLS.md"] as const;

const SECTION_MAP: Record<string, string> = {
  "IDENTITY.md": "Identity",
  "SOUL.md": "Personality & Values",
  "AGENTS.md": "Session Rules",
  "USER.md": "About the User",
  "TOOLS.md": "Tools & Environment",
};

// Files we scaffold from templates/ on a fresh workspace init.
// CLAUDE.md tells the agent to read these at session start, so they need to
// exist as separate files for that loop to mean anything.
const SCAFFOLDED_FILES: Array<{ workspace: string; template: string }> = [
  { workspace: "SOUL.md", template: "soul.md" },
  { workspace: "IDENTITY.md", template: "identity.md" },
  { workspace: "USER.md", template: "user.md" },
];

function templatesDir(): string {
  // src/cli/workspace.ts → ../../templates
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "templates");
}

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
## Session Startup
Before doing anything else at the start of a session:
1. Read \`SOUL.md\` — that's who you are
2. Read \`USER.md\` — that's who you're helping
3. Read \`IDENTITY.md\` — your name, vibe, signature
Don't ask permission. Just do it.

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

/**
 * Copy soul scaffolding files (SOUL/IDENTITY/USER) from templates/ into the
 * workspace. Skips any file that already exists — never clobbers an agent's
 * personality. Returns the names of files actually created.
 */
async function scaffoldSoulFiles(workspacePath: string): Promise<string[]> {
  const created: string[] = [];
  const tplDir = templatesDir();

  for (const { workspace, template } of SCAFFOLDED_FILES) {
    const target = join(workspacePath, workspace);
    if (existsSync(target)) continue;

    const source = join(tplDir, template);
    const content = await readOptionalFile(source);
    if (!content) continue;

    await Bun.write(target, content + "\n");
    created.push(workspace);
  }

  return created;
}

/**
 * Initialize a workspace: write CLAUDE.md and scaffold SOUL/IDENTITY/USER if
 * they don't exist. Used both by `clawster workspace init` and (via auto-chain)
 * `clawster agent add`.
 *
 * Returns a summary of what happened so callers can print appropriate output.
 */
export async function initializeWorkspace(opts: {
  workspacePath: string;
  name: string;
  merge?: boolean;
  /**
   * When true, only scaffold SOUL/IDENTITY/USER files — never touch CLAUDE.md.
   * Safe to run against existing workspaces with customized CLAUDE.md content.
   * Takes precedence over `merge` if both are set.
   */
  soulOnly?: boolean;
}): Promise<{
  claudeMd: "created" | "merged" | "skipped";
  soulFilesCreated: string[];
  mergedFrom: string[];
  /** Path to CLAUDE.md backup, if one was created during an overwrite. */
  backupPath?: string;
}> {
  const { workspacePath, name, merge, soulOnly } = opts;
  const claudeMdPath = join(workspacePath, "CLAUDE.md");

  const soulFilesCreated = await scaffoldSoulFiles(workspacePath);

  // `soulOnly` short-circuits all CLAUDE.md handling. Used to safely add soul
  // scaffolding to existing workspaces without touching their CLAUDE.md.
  if (soulOnly) {
    return { claudeMd: "skipped", soulFilesCreated, mergedFrom: [] };
  }

  if (existsSync(claudeMdPath) && !merge) {
    return { claudeMd: "skipped", soulFilesCreated, mergedFrom: [] };
  }

  const files: Record<string, string | null> = {};
  const mergedFrom: string[] = [];

  if (merge) {
    for (const sourceFile of SOURCE_FILES) {
      const content = await readOptionalFile(join(workspacePath, sourceFile));
      files[sourceFile] = content;
      if (content) mergedFrom.push(sourceFile);
    }
  } else {
    for (const sourceFile of SOURCE_FILES) {
      files[sourceFile] = null;
    }
  }

  // Safety net: `--merge` regenerates CLAUDE.md from templates + source files,
  // which destroys any custom content in an existing CLAUDE.md. Back it up
  // before overwriting so users have a recovery path without digging into git.
  let backupPath: string | undefined;
  if (merge && existsSync(claudeMdPath)) {
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    backupPath = `${claudeMdPath}.bak.${ts}`;
    await copyFile(claudeMdPath, backupPath);
  }

  const claudeMd = buildClaudeMd(name, files);
  await Bun.write(claudeMdPath, claudeMd);

  return {
    claudeMd: merge ? "merged" : "created",
    soulFilesCreated,
    mergedFrom,
    backupPath,
  };
}

export const workspaceCommand = new Command("workspace").description(
  "Manage agent workspaces"
);

workspaceCommand
  .command("init <path>")
  .description("Initialize a workspace with CLAUDE.md and soul scaffolding")
  .option("--name <name>", "Agent name for the CLAUDE.md header", "Agent")
  .option("--merge", "Rebuild CLAUDE.md from SOUL/IDENTITY/USER templates (backs up existing CLAUDE.md to CLAUDE.md.bak.<ts>)")
  .option("--soul-only", "Only scaffold SOUL/IDENTITY/USER files — do not touch CLAUDE.md (safe for existing workspaces)")
  .action(async (workspacePath: string, opts: { name: string; merge?: boolean; soulOnly?: boolean }) => {
    if (opts.merge && opts.soulOnly) {
      console.log("Both --merge and --soul-only given — using --soul-only (safer).");
    }

    const result = await initializeWorkspace({
      workspacePath,
      name: opts.name,
      merge: opts.merge,
      soulOnly: opts.soulOnly,
    });

    if (opts.soulOnly) {
      console.log(`CLAUDE.md left untouched (--soul-only).`);
    } else if (result.claudeMd === "skipped") {
      console.log(
        `CLAUDE.md already exists at ${join(workspacePath, "CLAUDE.md")}. Use --soul-only to scaffold soul files without touching it, or --merge to rebuild it (backs up the existing file).`
      );
    } else if (result.claudeMd === "merged" && result.mergedFrom.length > 0) {
      console.log(`CLAUDE.md rebuilt from: ${result.mergedFrom.join(", ")}`);
    } else {
      console.log(`CLAUDE.md template created at ${join(workspacePath, "CLAUDE.md")}`);
    }

    if (result.backupPath) {
      console.log(`Existing CLAUDE.md backed up to: ${result.backupPath}`);
    }

    if (result.soulFilesCreated.length > 0) {
      console.log(`Soul scaffolding created: ${result.soulFilesCreated.join(", ")}`);
    }
  });
