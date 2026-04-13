import { Command } from "commander";
import { createInterface } from "readline";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import {
  getClawsterHome,
  loadConfig,
  saveAgents,
} from "../core/config.ts";
import type { AgentsConfig } from "../core/config.ts";
import type { AgentConfig } from "../core/types.ts";

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

async function loadAgentsFile(): Promise<AgentsConfig> {
  const home = getClawsterHome();
  const agentsPath = join(home, "agents.json");
  try {
    return JSON.parse(await readFile(agentsPath, "utf-8"));
  } catch {
    return { agents: [], unboundChatIds: [] };
  }
}

export const agentCommand = new Command("agent").description(
  "Manage agents"
);

// clawster agent add <name>
agentCommand
  .command("add <name>")
  .description("Add a new agent")
  .action(async (name: string) => {
    const agentsData = await loadAgentsFile();

    // Check for duplicate
    const id = name.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    if (agentsData.agents.some((a) => a.id === id)) {
      console.error(`Agent "${id}" already exists.`);
      process.exit(1);
    }

    const workspace = await ask("Workspace path");
    if (!workspace) {
      console.error("Workspace path is required.");
      process.exit(1);
    }

    const telegramChatId = await ask(
      "Telegram chat ID (or run 'clawster agent discover' to find it)",
      ""
    );

    const wantsHeartbeat = await ask("Configure heartbeat? (y/N)", "N");
    let heartbeat: AgentConfig["heartbeat"] | undefined;
    if (wantsHeartbeat.toLowerCase() === "y") {
      const every = await ask("Heartbeat interval (e.g. 30m, 1h)", "1h");
      const activeHoursInput = await ask(
        "Active hours (e.g. 08:00-22:00, or blank for always)",
        ""
      );
      let activeHours: { start: string; end: string } | undefined;
      if (activeHoursInput.includes("-")) {
        const [start, end] = activeHoursInput.split("-");
        activeHours = { start: start!.trim(), end: end!.trim() };
      }
      heartbeat = {
        every,
        target: "telegram" as const,
        to: telegramChatId || "",
        ...(activeHours ? { activeHours } : {}),
      };
    }

    const agent: AgentConfig = {
      id,
      name,
      workspace,
      telegramChatId: telegramChatId || "",
      ...(heartbeat ? { heartbeat } : {}),
    };

    agentsData.agents.push(agent);
    await saveAgents(agentsData);
    console.log(`\nAgent "${name}" (${id}) added.`);
  });

// clawster agent list
agentCommand
  .command("list")
  .description("List all agents")
  .action(async () => {
    const agentsData = await loadAgentsFile();

    if (agentsData.agents.length === 0) {
      console.log("No agents configured.");
      return;
    }

    // Header
    const cols = {
      id: 16,
      name: 20,
      workspace: 40,
      chat: 18,
      tasks: 50,
    };

    console.log(
      [
        "ID".padEnd(cols.id),
        "Name".padEnd(cols.name),
        "Workspace".padEnd(cols.workspace),
        "Chat ID".padEnd(cols.chat),
        "Tasks".padEnd(cols.tasks),
      ].join("  ")
    );
    console.log("-".repeat(cols.id + cols.name + cols.workspace + cols.chat + cols.tasks + 8));

    for (const a of agentsData.agents) {
      const defaultMarker = a.isDefault ? " *" : "";

      let tasksDisplay = "-";
      if (a.tasks && a.tasks.length > 0) {
        tasksDisplay = a.tasks.map((t) => `${t.name} (${t.schedule})`).join(", ");
      } else if (a.heartbeat?.every) {
        tasksDisplay = `heartbeat (${a.heartbeat.every})`;
      }

      console.log(
        [
          (a.id + defaultMarker).padEnd(cols.id),
          a.name.padEnd(cols.name),
          a.workspace.slice(0, cols.workspace).padEnd(cols.workspace),
          (a.telegramChatId || "-").padEnd(cols.chat),
          tasksDisplay,
        ].join("  ")
      );
    }

    console.log(`\n${agentsData.agents.length} agent(s). * = default`);
  });

// clawster agent remove <name>
agentCommand
  .command("remove <name>")
  .description("Remove an agent")
  .action(async (name: string) => {
    const agentsData = await loadAgentsFile();
    const idx = agentsData.agents.findIndex(
      (a) => a.id === name || a.name === name
    );

    if (idx === -1) {
      console.error(`Agent "${name}" not found.`);
      process.exit(1);
    }

    const agent = agentsData.agents[idx]!;
    const confirm = await ask(
      `Remove agent "${agent.name}" (${agent.id})? (y/N)`,
      "N"
    );
    if (confirm.toLowerCase() !== "y") {
      console.log("Aborted.");
      return;
    }

    agentsData.agents.splice(idx, 1);
    await saveAgents(agentsData);
    console.log(`Agent "${agent.name}" removed.`);
  });

// clawster agent discover
agentCommand
  .command("discover")
  .description("Discover Telegram chat IDs by listening for messages")
  .action(async () => {
    const home = getClawsterHome();
    const configPath = join(home, "config.json");

    let botToken: string;
    let allowedUserId: string;
    try {
      const cfg = JSON.parse(await readFile(configPath, "utf-8"));
      botToken = cfg.botToken;
      allowedUserId = cfg.allowedUserId;
    } catch {
      console.error("Config not found. Run 'clawster init' first.");
      process.exit(1);
      return;
    }

    if (!botToken) {
      console.error("No bot token in config.");
      process.exit(1);
      return;
    }

    const { Bot } = await import("grammy");
    const bot = new Bot(botToken);
    const discovered = new Map<string, string>();

    bot.use(async (ctx, next) => {
      if (ctx.from?.id.toString() !== allowedUserId) return;
      await next();
    });

    bot.on("message", (ctx) => {
      const chatId = ctx.chat.id.toString();
      const title = "title" in ctx.chat ? ctx.chat.title : "DM";
      const chatType = ctx.chat.type;
      const topicId = ctx.message.message_thread_id;

      const key = topicId ? `${chatId}:${topicId}` : chatId;

      if (!discovered.has(key)) {
        discovered.set(key, title ?? "unknown");
        if (topicId) {
          console.log(`\n  chat "${chatId}" topic ${topicId} — "${title}" (${chatType})`);
        } else {
          console.log(`\n  chat "${chatId}" — "${title}" (${chatType})`);
        }
        console.log(`  --- ${discovered.size} entry/entries discovered so far ---`);
      }
    });

    console.log("Discovery mode — send a message in each Telegram group/chat.");
    console.log("Press Ctrl+C when done.\n");
    console.log("Discovered chats:");

    bot.start();

    process.on("SIGINT", () => {
      console.log("\n\n=== Final mapping ===\n");
      for (const [key, title] of discovered) {
        if (key.includes(":")) {
          const [chatId, topicId] = key.split(":");
          console.log(`  chat "${chatId}" topic ${topicId} — "${title}"`);
        } else {
          console.log(`  chat "${key}" — "${title}"`);
        }
      }
      console.log(`\nTotal: ${discovered.size} entry/entries`);
      process.exit(0);
    });
  });
