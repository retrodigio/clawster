import { Command } from "commander";
import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

function findLogFile(): string | null {
  const candidates = [
    join(getClawsterHome(), "logs", "clawster.log"),
    join(homedir(), "Library", "Logs", "clawster.log"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return null;
}

export const logsCommand = new Command("logs")
  .description("View Clawster logs")
  .option("-f, --follow", "Follow log output (tail -f)")
  .action(async (opts: { follow?: boolean }) => {
    const logFile = findLogFile();
    if (!logFile) {
      console.error("No log file found. Checked:");
      console.error(`  ${join(getClawsterHome(), "logs", "clawster.log")}`);
      console.error(`  ${join(homedir(), "Library", "Logs", "clawster.log")}`);
      process.exit(1);
    }

    const args = opts.follow ? ["-f", logFile] : ["-50", logFile];
    const proc = Bun.spawn(["tail", ...args], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  });
