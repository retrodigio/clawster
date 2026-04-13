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
          name: "Clawster",
          workspace: join(homedir(), ".clawster"),
          telegramChatId: "",
          isDefault: true,
        },
      ],
      unboundChatIds: [],
    };
    await saveAgents(agents);

    console.log(`\nDone! Config written to ${home}`);
    console.log("Next steps: clawster agent add <name>, clawster start\n");
  });
