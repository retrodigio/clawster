import { $ } from "bun";
import { readFileSync, existsSync } from "node:fs";
import path from "node:path";

const HOME = process.env.HOME!;
const LOGS_DIR = path.join(HOME, "Library", "Logs");

const SERVICES = [
  { name: "Orchestrator", label: "com.claude.orchestrator", logPrefix: "claude-orchestrator" },
  { name: "Open Brain", label: "com.claude.open-brain", logPrefix: "open-brain" },
];

function lastLines(filePath: string, n: number): string[] {
  if (!existsSync(filePath)) return [`(file not found: ${filePath})`];
  try {
    const content = readFileSync(filePath, "utf-8");
    const lines = content.split("\n").filter(Boolean);
    return lines.slice(-n);
  } catch {
    return ["(could not read)"];
  }
}

async function main() {
  console.log("=== Claude Orchestrator Status ===\n");

  // Check each service via launchctl
  let listOutput: string;
  try {
    listOutput = await $`launchctl list`.text();
  } catch {
    listOutput = "";
  }

  for (const svc of SERVICES) {
    console.log(`--- ${svc.name} (${svc.label}) ---`);

    const match = listOutput.split("\n").find((line) => line.includes(svc.label));
    if (match) {
      const parts = match.trim().split(/\s+/);
      const pid = parts[0] === "-" ? "not running" : `PID ${parts[0]}`;
      const status = parts[1];
      console.log(`  Status: loaded | ${pid} | exit code: ${status}`);
    } else {
      console.log(`  Status: NOT loaded`);
    }

    // Logs
    const outLog = path.join(LOGS_DIR, `${svc.logPrefix}.log`);
    const errLog = path.join(LOGS_DIR, `${svc.logPrefix}.error.log`);

    console.log(`\n  Last 5 lines of stdout (${outLog}):`);
    for (const line of lastLines(outLog, 5)) {
      console.log(`    ${line}`);
    }

    console.log(`\n  Last 5 lines of stderr (${errLog}):`);
    for (const line of lastLines(errLog, 5)) {
      console.log(`    ${line}`);
    }

    console.log();
  }

  // Health check
  console.log("--- Health Endpoint ---");
  try {
    const resp = await fetch("http://localhost:18800/health", { signal: AbortSignal.timeout(3000) });
    const data = await resp.json();
    console.log(`  Status: ${resp.status}`);
    console.log(`  Response: ${JSON.stringify(data, null, 2)}`);
  } catch (err: any) {
    console.log(`  Health endpoint unreachable: ${err.message}`);
  }

  console.log("\n=== End Status ===");
}

main();
