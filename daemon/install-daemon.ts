import { $ } from "bun";
import path from "node:path";
import { copyFileSync, mkdirSync, existsSync } from "node:fs";

const HOME = process.env.HOME!;
const LAUNCH_AGENTS_DIR = path.join(HOME, "Library", "LaunchAgents");
const LOGS_DIR = path.join(HOME, "Library", "Logs");
const DAEMON_DIR = path.join(import.meta.dir);

const SERVICES: Record<string, string> = {
  orchestrator: "com.claude.orchestrator",
  "open-brain": "com.claude.open-brain",
};

function parseArgs(): string[] {
  const args = process.argv.slice(2);
  const serviceIdx = args.indexOf("--service");
  if (serviceIdx === -1 || serviceIdx + 1 >= args.length) {
    return Object.keys(SERVICES); // default: all
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

async function installService(name: string, label: string, uid: string) {
  const plistFile = `${label}.plist`;
  const srcPath = path.join(DAEMON_DIR, plistFile);
  const destPath = path.join(LAUNCH_AGENTS_DIR, plistFile);

  console.log(`\n--- Installing ${name} (${label}) ---`);

  if (!existsSync(srcPath)) {
    console.error(`  [ERROR] Plist not found: ${srcPath}`);
    return false;
  }

  // Unload existing version (ignore errors)
  console.log(`  Unloading existing service...`);
  try {
    await $`launchctl bootout gui/${uid} ${destPath}`.quiet();
    console.log(`  Unloaded previous version.`);
  } catch {
    console.log(`  No existing service to unload (OK).`);
  }

  // Copy plist to LaunchAgents
  console.log(`  Copying plist to ${destPath}`);
  copyFileSync(srcPath, destPath);

  // Load the service
  console.log(`  Loading service...`);
  try {
    await $`launchctl bootstrap gui/${uid} ${destPath}`.quiet();
    console.log(`  [OK] Service loaded.`);
  } catch (err: any) {
    console.error(`  [ERROR] Failed to load: ${err.message}`);
    return false;
  }

  // Verify
  try {
    const list = await $`launchctl list`.text();
    const match = list.split("\n").find((line) => line.includes(label));
    if (match) {
      console.log(`  [OK] Verified running: ${match.trim()}`);
    } else {
      console.warn(`  [WARN] Service loaded but not found in launchctl list.`);
    }
  } catch {
    console.warn(`  [WARN] Could not verify service status.`);
  }

  return true;
}

async function main() {
  const services = parseArgs();
  const uid = await getUid();

  console.log(`UID: ${uid}`);
  console.log(`Installing services: ${services.join(", ")}`);

  // Ensure directories exist
  mkdirSync(LOGS_DIR, { recursive: true });
  mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });

  let allOk = true;
  for (const name of services) {
    const ok = await installService(name, SERVICES[name]!, uid);
    if (!ok) allOk = false;
  }

  console.log(allOk ? "\nAll services installed successfully." : "\nSome services failed to install.");
  process.exit(allOk ? 0 : 1);
}

main();
