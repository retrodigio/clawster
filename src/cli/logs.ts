import { Command } from "commander";
import { existsSync } from "fs";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

function logPath(error: boolean): string {
  const name = error ? "clawster.error.log" : "clawster.log";
  return join(getClawsterHome(), "logs", name);
}

export const logsCommand = new Command("logs")
  .description("View Clawster logs")
  .option("-f, --follow", "Follow log output (tail -f)")
  .option("-e, --error", "Show the error log (startup crashes land here, not in the main log)")
  .option("-n, --lines <count>", "Number of lines to show", "50")
  .action(async (opts: { follow?: boolean; error?: boolean; lines?: string }) => {
    const logFile = logPath(Boolean(opts.error));
    if (!existsSync(logFile)) {
      console.error(`No log file found at ${logFile}`);
      if (!opts.error && existsSync(logPath(true))) {
        console.error("An error log exists — try 'clawster logs --error'.");
      }
      process.exit(1);
    }

    const count = parseInt(opts.lines ?? "50", 10) || 50;
    const args = opts.follow ? ["-f", logFile] : [`-${count}`, logFile];
    const proc = Bun.spawn(["tail", ...args], {
      stdout: "inherit",
      stderr: "inherit",
    });
    await proc.exited;
  });
