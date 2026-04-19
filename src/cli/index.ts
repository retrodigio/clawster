#!/usr/bin/env bun

import { Command } from "commander";
import { readFileSync } from "fs";
import { join } from "path";

const pkg = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf-8")
);

const program = new Command();

program
  .name("clawster")
  .description("Clawster — autonomous AI agent orchestrator")
  .version(pkg.version || "0.1.0");

// Import and register subcommands
import { initCommand } from "./init.ts";
import { startCommand } from "./start.ts";
import { stopCommand } from "./stop.ts";
import { restartCommand } from "./restart.ts";
import { statusCommand } from "./status.ts";
import { logsCommand } from "./logs.ts";
import { agentCommand } from "./agent.ts";
import { daemonCommand } from "./daemon.ts";
import { workspaceCommand } from "./workspace.ts";
import { migrateCommand } from "./migrate.ts";
import { msgCommand } from "./msg.ts";

program.addCommand(initCommand);
program.addCommand(startCommand);
program.addCommand(stopCommand);
program.addCommand(restartCommand);
program.addCommand(statusCommand);
program.addCommand(logsCommand);
program.addCommand(agentCommand);
program.addCommand(daemonCommand);
program.addCommand(workspaceCommand);
program.addCommand(migrateCommand);
program.addCommand(msgCommand);

program.parse();
