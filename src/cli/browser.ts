import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { readFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { getClawsterHome, saveAgents, type AgentsConfig } from "../core/config.ts";

/**
 * Browser access for agents, via Claude Code's native Chrome integration.
 *
 * This replaces an earlier design that launched a dedicated Chrome with
 * `--remote-debugging-port=9222` and drove it through `npx @playwright/mcp`
 * over CDP. The harness now ships `--chrome`, which talks to the Claude in
 * Chrome extension through a native-messaging host. That is better on every
 * axis we cared about: no unauthenticated CDP port open on localhost, no npx
 * cold start on every run, no second browser to keep logged in, and the
 * browser is one Chris can actually see and take over.
 *
 * What we keep from the old design is the reason it existed: blast radius.
 * The extension shares whatever browser it is attached to, so pointing agents
 * at the everyday profile would hand a fleet running `bypassPermissions` the
 * same session cookies as banking and work email. Instead we give agents their
 * own Chrome *profile* inside the normal user-data-dir. Profiles have separate
 * cookies and separate extension state, but share the native-messaging host at
 * the user-data-dir level — so the host installed for the everyday profile
 * already covers this one, and there is nothing extra to register.
 */

/** Chrome profile directory name, relative to the Chrome user-data-dir. */
const PROFILE_DIR = process.env.CLAWSTER_CHROME_PROFILE || "Clawster";

/** The flag Clawster sets on an agent to grant browser access. */
const CHROME_FLAG = "chrome";

function chromeUserDataDir(): string {
  if (process.env.CLAWSTER_CHROME_USER_DATA_DIR) return process.env.CLAWSTER_CHROME_USER_DATA_DIR;
  return process.platform === "darwin"
    ? join(homedir(), "Library", "Application Support", "Google", "Chrome")
    : join(homedir(), ".config", "google-chrome");
}

/**
 * The native-messaging host manifest Claude Code installs the first time
 * Chrome integration is enabled. It lives beside the profiles rather than
 * inside one, which is what makes a second profile free.
 */
function nativeHostManifest(): string {
  return join(chromeUserDataDir(), "NativeMessagingHosts", "com.anthropic.claude_code_browser_extension.json");
}

/** Chrome Web Store id of the Claude in Chrome extension. */
const EXTENSION_ID = "fcoeoabgfenejglbffodgkkbkcdhcgfn";
const EXTENSION_URL = `https://chromewebstore.google.com/detail/claude/${EXTENSION_ID}`;

function extensionInstalledIn(profile: string): boolean {
  return existsSync(join(chromeUserDataDir(), profile, "Extensions", EXTENSION_ID));
}

function findChromeBinary(): string | null {
  if (process.env.CLAWSTER_CHROME_BIN && existsSync(process.env.CLAWSTER_CHROME_BIN)) {
    return process.env.CLAWSTER_CHROME_BIN;
  }
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  return candidates.find((p) => existsSync(p)) ?? null;
}

async function loadAgentsFile(): Promise<AgentsConfig> {
  try {
    return JSON.parse(await readFile(join(getClawsterHome(), "agents.json"), "utf-8"));
  } catch {
    return { agents: [], unboundChatIds: [] };
  }
}

function isGranted(agent: { extraArgs?: Record<string, string | null> }): boolean {
  return agent.extraArgs !== undefined && CHROME_FLAG in agent.extraArgs;
}

export const browserCommand = new Command("browser").description(
  "Manage agent browser access (Claude in Chrome)",
);

browserCommand
  .command("status")
  .description("Check whether browser access is wired up, and who has it")
  .action(async () => {
    const host = nativeHostManifest();
    const bin = findChromeBinary();
    const agents = (await loadAgentsFile()).agents;
    const granted = agents.filter(isGranted);

    console.log("\n=== Browser Access ===\n");
    console.log(`  Chrome binary:      ${bin ?? "NOT FOUND"}`);
    console.log(`  Native host:        ${existsSync(host) ? "installed" : "MISSING — run a session with --chrome once"}`);
    console.log(`  Extension (Default):${extensionInstalledIn("Default") ? " installed" : " not installed"}`);
    console.log(`  Extension (${PROFILE_DIR}): ${extensionInstalledIn(PROFILE_DIR) ? "installed" : "NOT INSTALLED — run: clawster browser init"}`);
    console.log(`  Agent profile dir:  ${join(chromeUserDataDir(), PROFILE_DIR)}`);

    console.log(`\n  Agents with browser access (${granted.length}/${agents.length}):`);
    if (granted.length === 0) {
      console.log("    (none) — grant with: clawster browser grant <agentId>");
    } else {
      for (const a of granted) console.log(`    ${a.id}  (${a.name})`);
    }

    // Chrome must actually be running. `list_connected_browsers` reports a
    // browser from its last session even when none is open, so an agent can
    // believe it has a browser and then fail on the first action.
    const running = await isChromeRunning();
    console.log(`\n  Chrome running:     ${running ? "yes" : "NO — browser actions will fail until it is"}`);
    console.log("");
  });

browserCommand
  .command("init")
  .description(`Create and open the dedicated "${PROFILE_DIR}" Chrome profile for agents`)
  .action(async () => {
    const bin = findChromeBinary();
    if (!bin) {
      console.error("Chrome not found. Set CLAWSTER_CHROME_BIN to its path.");
      process.exit(1);
    }

    await mkdir(join(chromeUserDataDir(), PROFILE_DIR), { recursive: true });

    console.log(`\nOpening the "${PROFILE_DIR}" Chrome profile.\n`);
    console.log("This profile is separate from your everyday one: separate cookies,");
    console.log("separate logins, separate extensions. Agents get this profile and");
    console.log("nothing else, so a prompt-injected agent cannot reach the sessions");
    console.log("in your Default profile.\n");
    console.log("Two things to do in the window that opens:\n");
    console.log(`  1. Install the Claude in Chrome extension:`);
    console.log(`     ${EXTENSION_URL}`);
    console.log(`  2. Sign in to claude.ai in this profile — the extension cannot`);
    console.log(`     authenticate without it.\n`);
    console.log("Then log into the sites you want agents to reach, and only those.\n");
    console.log("Verify with: clawster browser status\n");

    const child = spawn(bin, [`--profile-directory=${PROFILE_DIR}`, EXTENSION_URL], {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
  });

browserCommand
  .command("grant <agentId>")
  .description("Give an agent browser access (adds --chrome to its runs)")
  .action(async (agentId: string) => {
    const data = await loadAgentsFile();
    const agent = data.agents.find((a) => a.id === agentId);
    if (!agent) {
      console.error(`No agent with id "${agentId}".`);
      process.exit(1);
    }
    if (isGranted(agent)) {
      console.log(`${agent.name} already has browser access.`);
      return;
    }
    // `null` is the SDK's encoding for a boolean CLI flag; agent-runner passes
    // extraArgs straight through to the query options.
    agent.extraArgs = { ...(agent.extraArgs ?? {}), [CHROME_FLAG]: null };
    await saveAgents(data);
    console.log(`Granted browser access to ${agent.name} (${agent.id}).`);
    console.log(`Takes effect on that agent's next run — no restart needed.`);
  });

browserCommand
  .command("revoke <agentId>")
  .description("Remove an agent's browser access")
  .action(async (agentId: string) => {
    const data = await loadAgentsFile();
    const agent = data.agents.find((a) => a.id === agentId);
    if (!agent) {
      console.error(`No agent with id "${agentId}".`);
      process.exit(1);
    }
    if (!isGranted(agent)) {
      console.log(`${agent.name} does not have browser access.`);
      return;
    }
    delete agent.extraArgs![CHROME_FLAG];
    if (Object.keys(agent.extraArgs!).length === 0) delete agent.extraArgs;
    await saveAgents(data);
    console.log(`Revoked browser access from ${agent.name} (${agent.id}).`);
  });

async function isChromeRunning(): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("pgrep", ["-x", process.platform === "darwin" ? "Google Chrome" : "chrome"]);
    p.on("close", (code) => resolve(code === 0));
    p.on("error", () => resolve(false));
  });
}
