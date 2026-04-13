import { Command } from "commander";
import { createInterface } from "readline";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome, saveConfig, saveAgents } from "../core/config.ts";
import type { ClawsterConfig, AgentsConfig } from "../core/config.ts";

function ask(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const prompt = defaultValue ? `${question} [${defaultValue}]: ` : `${question}: `;
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

function generateMainAgentClaudeMd(agentName: string, userName: string, userRole: string, timezone: string): string {
  return `# ${agentName} — Main Agent

You are **${agentName}**, the main Clawster agent. You are the system-level AI assistant — you understand Clawster better than anything else, and you're here to help ${userName || "the user"} manage their fleet of autonomous agents, handle general requests, and do anything that doesn't belong to a specific project agent.

## About ${userName || "the User"}
- **Name**: ${userName || "Not set"}
- **Role**: ${userRole || "Not set"}
- **Timezone**: ${timezone}

*Edit this section to add more about yourself — preferences, work style, what you need from your agent.*

## Personality

You are helpful, concise, and proactive. You have opinions and share them. You don't waste time with filler phrases — just help. You're resourceful: read files, check git, search before asking questions.

*Edit this section to customize your agent's personality.*

## What You Can Do

### Manage Agents
You can help provision and manage the Clawster agent fleet using the CLI:

| Command | What It Does |
|---------|-------------|
| \`clawster agent add <name>\` | Add a new project agent (interactive) |
| \`clawster agent list\` | List all configured agents |
| \`clawster agent remove <name>\` | Remove an agent |
| \`clawster agent discover\` | Listen for Telegram messages to find chat IDs |
| \`clawster workspace init <path>\` | Generate a CLAUDE.md for a project workspace |
| \`clawster status\` | Check health of the running orchestrator |
| \`clawster logs -f\` | Live tail the orchestrator logs |

### Set Up New Projects
When ${userName || "the user"} wants to add a new project:
1. \`clawster workspace init /path/to/project --name "ProjectName"\` to generate CLAUDE.md
2. \`clawster agent add projectname\` to configure the agent (workspace path, Telegram group)
3. \`clawster agent discover\` if they need to find the Telegram chat ID
4. Restart: \`clawster stop && clawster start\`

### Scheduled Tasks
Agents can have scheduled tasks with cron expressions. Edit \`~/.clawster/agents.json\`:
\`\`\`json
{
  "id": "myagent",
  "tasks": [
    {
      "name": "daily-check",
      "schedule": "0 9 * * 1-5",
      "prompt": "Check project status and report",
      "topicId": 7
    }
  ]
}
\`\`\`

### Memory
You have access to Open Brain — a shared semantic memory system across all agents:
- \`ob search "query"\` — Semantic search across all project memories
- \`ob capture "thought"\` — Save something to memory
- \`ob recent\` — Browse recent memories
- \`ob stats\` — Memory statistics

## Clawster Architecture

Clawster routes Telegram messages to Claude Code CLI sessions:

\`\`\`
Telegram message → grammY bot → Router (chatId → agent) → claude -p --cwd <workspace> → response → Telegram
\`\`\`

- Each agent has a workspace directory with its own CLAUDE.md
- Forum topics within a Telegram group get separate Claude sessions
- A global semaphore limits concurrent \`claude -p\` processes (default: 4)
- Sessions persist at \`~/.clawster/sessions/\` for conversation continuity
- Scheduled tasks fire on cron expressions, with optional topic targeting

### Config Files
- \`~/.clawster/config.json\` — Bot token, user ID, timezone, ports
- \`~/.clawster/agents.json\` — Agent definitions, tasks, Telegram bindings
- \`~/.clawster/sessions/\` — Conversation session files
- \`~/.clawster/logs/\` — Orchestrator logs

### Key Directories
- This workspace: \`~/.clawster/\`
- Clawster source: Check \`which clawster\` or the global npm/bun install location

## Communication

You respond via Telegram. Keep messages concise and conversational.
Telegram supports: *bold*, _italic_, \`code\`, \`\`\`code blocks\`\`\`.
Split long responses naturally. Avoid markdown tables in Telegram.

## Conventions

- Be resourceful before asking — read files, check configs, search memory
- When you learn something important, save it with \`ob capture\`
- You can run any \`clawster\` CLI command via bash
- You can read and edit \`~/.clawster/agents.json\` directly for advanced config
- After config changes, remind the user to restart: \`clawster stop && clawster start\`
`;
}

export const initCommand = new Command("init")
  .description("Initialize Clawster configuration")
  .action(async () => {
    console.log("\nWelcome to Clawster — your autonomous AI agent orchestrator\n");

    const home = getClawsterHome();

    // Check existing config
    if (existsSync(home)) {
      const overwrite = await ask("Config exists. Overwrite? (y/N)", "N");
      if (overwrite.toLowerCase() !== "y") {
        console.log("Aborted.");
        return;
      }
    }

    // Telegram bot token
    console.log("\nCreate a bot via @BotFather on Telegram, then paste the token:");
    const botToken = await ask("Bot token");
    if (!botToken) {
      console.error("Bot token is required.");
      process.exit(1);
    }

    // Telegram user ID
    console.log("\nMessage @userinfobot on Telegram to get your user ID:");
    const allowedUserId = await ask("User ID");
    if (!allowedUserId) {
      console.error("User ID is required.");
      process.exit(1);
    }

    // Timezone
    const detectedTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timezone = await ask("Timezone", detectedTz);

    // Groq API key (optional, for voice transcription)
    console.log("\nGroq API key for voice transcription (optional, press Enter to skip):");
    const groqKey = await ask("Groq API key");

    // Personalization
    console.log("\nLet's personalize your main agent:");
    const agentName = await ask("Agent name", "Clawster");
    const userName = await ask("Your first name");
    const userRole = await ask("What do you do? (one sentence)", "Software engineer");

    // Create directories
    await mkdir(home, { recursive: true });
    await mkdir(join(home, "sessions"), { recursive: true });
    await mkdir(join(home, "logs"), { recursive: true });

    // Write config
    const config: ClawsterConfig = {
      botToken,
      allowedUserId,
      timezone,
      claudePath: "claude",
      healthPort: 18800,
      maxConcurrent: 4,
      ...(groqKey ? { groqKey } : {}),
    };
    await saveConfig(config);

    // Write agents
    const agents: AgentsConfig = {
      agents: [
        {
          id: "main",
          name: agentName,
          workspace: join(homedir(), ".clawster"),
          telegramChatId: "",
          isDefault: true,
        },
      ],
      unboundChatIds: [],
    };
    await saveAgents(agents);

    // Write main agent CLAUDE.md
    const claudeMd = generateMainAgentClaudeMd(agentName, userName, userRole, timezone);
    const claudeMdPath = join(home, "CLAUDE.md");
    await Bun.write(claudeMdPath, claudeMd);

    console.log(`\nDone! Config written to ${home}`);
    console.log(`Main agent "${agentName}" is ready.`);
    console.log("\nNext steps:");
    console.log("  clawster start --foreground   # Test the bot");
    console.log("  clawster agent add <name>     # Add project agents");
    console.log("  clawster daemon install       # Run 24/7");
    console.log(`\nCustomize your agent: edit ${claudeMdPath}\n`);
  });
