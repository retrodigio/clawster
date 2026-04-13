import { Command } from "commander";
import { readFile } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function lastLines(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) return [];
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return [];
  }
}

export const statusCommand = new Command("status")
  .description("Show Clawster status")
  .action(async () => {
    const home = getClawsterHome();
    const lockFile = join(home, "clawster.lock");

    console.log("\n=== Clawster Status ===\n");

    // Process status
    let pid: number | null = null;
    let running = false;
    if (existsSync(lockFile)) {
      try {
        const pidStr = await readFile(lockFile, "utf-8");
        pid = parseInt(pidStr.trim(), 10);
        if (!isNaN(pid)) {
          running = isPidAlive(pid);
        }
      } catch {
        // Lock file unreadable
      }
    }

    console.log(`  Process: ${running ? `running (PID ${pid})` : "not running"}`);

    // Health check
    let healthPort = 18800;
    try {
      const configPath = join(home, "config.json");
      if (existsSync(configPath)) {
        const cfg = JSON.parse(readFileSync(configPath, "utf-8"));
        if (cfg.healthPort) healthPort = cfg.healthPort;
      }
    } catch {
      // Use default port
    }

    try {
      const resp = await fetch(`http://localhost:${healthPort}/health`, {
        signal: AbortSignal.timeout(3000),
      });
      const data = (await resp.json()) as Record<string, unknown>;
      console.log(`  Health:  ${resp.status === 200 ? "OK" : "unhealthy"}`);
      if (data.agents) console.log(`  Agents:  ${data.agents}`);
      if (data.uptime) console.log(`  Uptime:  ${data.uptime}s`);
      if (data.lastActivity) console.log(`  Last:    ${data.lastActivity}`);
    } catch {
      console.log("  Health:  endpoint unreachable");
    }

    // Agent count from config
    try {
      const agentsPath = join(home, "agents.json");
      if (existsSync(agentsPath)) {
        const agentsData = JSON.parse(readFileSync(agentsPath, "utf-8"));
        console.log(`  Config:  ${agentsData.agents?.length ?? 0} agent(s) configured`);
      }
    } catch {
      // No agents config
    }

    // Recent logs
    const logPaths = [
      join(home, "logs", "clawster.log"),
      join(homedir(), "Library", "Logs", "clawster.log"),
    ];
    for (const logPath of logPaths) {
      const lines = lastLines(logPath, 5);
      if (lines.length > 0) {
        console.log(`\n  Recent logs (${logPath}):`);
        for (const line of lines) {
          console.log(`    ${line}`);
        }
        break;
      }
    }

    console.log("\n=== End Status ===\n");
  });
