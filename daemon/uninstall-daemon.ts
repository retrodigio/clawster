import { $ } from "bun";
import path from "node:path";
import { unlinkSync, existsSync } from "node:fs";

const HOME = process.env.HOME!;
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");

const SERVICES: Record<string, string> = {
  orchestrator: "com.claude.orchestrator",
  "open-brain": "com.claude.open-brain",
};

function parseArgs(): string[] {
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  if (serviceIdx === -1 || serviceIdx + 1 >= args.length) {
    return Object.keys(SERVICES);
  }
  const value = args[serviceIdx + 1] ?? "all";
  if (value === "all") return Object.keys(SERVICES);
  if (!(value in SERVICES)) {
    console.error(`Unknown service: ${value}. Valid: ${Object.keys(SERVICES).join(", ")}, all`);
    process.exit(1);
  }
  return [value] as string[];
}

async function getUid(): Promise<string> {
  const result = await $`id -u`.text();
  return result.trim();
}

async function uninstallService(name: string, label: string, uid: string) {
  const plistFile = `${label}.plist`;
  const destPath = path.join(LAUNCH_AGENTS_DIR, plistFile);

  console.log(`\n--- Uninstalling ${name} (${label}) ---`);

  // Unload service
  console.log(`  Unloading service...`);
  try {
    await $`launchctl bootout gui/${uid} ${destPath}`.quiet();
    console.log(`  [OK] Service unloaded.`);
  } catch {
    console.log(`  Service was not loaded (OK).`);
  }

  // Remove plist
  if (existsSync(destPath)) {
    unlinkSync(destPath);
    console.log(`  [OK] Removed ${destPath}`);
  } else {
    console.log(`  Plist not found at ${destPath} (OK).`);
  }
}

async function main() {
  const services = parseArgs();
  const uid = await getUid();

  console.log(`UID: ${uid}`);
  console.log(`Uninstalling services: ${services.join(", ")}`);

  for (const name of services) {
    await uninstallService(name, SERVICES[name]!, uid);
  }

  console.log("\nDone.");
}

main();
