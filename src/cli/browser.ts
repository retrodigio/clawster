import { Command } from "commander";
import { spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;

/**
 * Dedicated user-data-dir for the Clawster debug Chrome. Keeping this
 * separate from the user's daily Chrome solves three problems at once:
 *   1. Avoids the LaunchServices flag-drop bug, where launching Chrome via
 *      `open -a "Google Chrome" --args ...` silently ignores the flags
 *      when any Chrome process is already running (helper processes,
 *      profile pickers, etc.). A separate user-data-dir forces a brand-new
 *      process tree that always honors --remote-debugging-port.
 *   2. Smaller blast radius. Only the sites you explicitly log into in
 *      this profile (FB, KSL, …) become reachable by Playwright-MCP-using
 *      agents. Your daily Chrome with banking, work email, etc. stays
 *      untouched.
 *   3. No conflict with your daily browsing. The debug Chrome runs in its
 *      own window; agents driving it via CDP don't grab focus from your
 *      tabs.
 */
function debugProfileDir(): string {
  return process.env.CLAWSTER_BROWSER_PROFILE || join(homedir(), ".clawster", "chrome-debug-profile");
}

/**
 * Common locations Chrome's binary ships at, in priority order. We launch
 * the binary directly rather than going through `open` because the macOS
 * launcher silently drops --args when an existing Chrome process owns the
 * LaunchServices slot.
 */
function findChromeBinary(): string | null {
  if (process.env.CLAWSTER_CHROME_BIN && existsSync(process.env.CLAWSTER_CHROME_BIN)) {
    return process.env.CLAWSTER_CHROME_BIN;
  }
  const candidates =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
          "/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  return null;
}

function buildLaunchArgs(profile: string): string[] {
  return [
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-features=ChromeWhatsNewUI,SigninInterceptBubbleV2",
  ];
}

function quote(s: string): string {
  return /[\s"'$`\\]/.test(s) ? `"${s.replace(/(["\\$`])/g, "\\$1")}"` : s;
}

function launchCmdForDisplay(binary: string, profile: string): string {
  return [quote(binary), ...buildLaunchArgs(profile).map(quote)].join(" ");
}

async function cdpAlive(timeoutMs = 1500): Promise<boolean> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    return resp.ok;
  } catch {
    return false;
  }
}

async function readChromeInfo(): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, { signal: AbortSignal.timeout(3000) });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const browserStatusCmd = new Command("status")
  .description("Check whether the debug Chrome is reachable on the CDP port")
  .action(async () => {
    const profile = debugProfileDir();
    console.log(`\nChecking ${CDP_URL}/json/version ...\n`);
    const info = await readChromeInfo();
    if (!info) {
      console.log(`  ✗ No CDP endpoint at ${CDP_URL}.`);
      console.log(`  Debug profile: ${profile}`);
      console.log("  → Run: clawster browser init");
      process.exit(1);
    }
    console.log("  ✓ CDP endpoint live.");
    console.log(`    Browser:           ${info.Browser ?? "(unknown)"}`);
    console.log(`    Protocol-Version:  ${info["Protocol-Version"] ?? "?"}`);
    console.log(`    User-Agent:        ${info["User-Agent"] ?? "?"}`);
    console.log(`    Debug profile:     ${profile}`);
    console.log("");
  });

const browserChromeCmd = new Command("chrome")
  .description("Print the Chrome launch command (for copy/paste)")
  .action(() => {
    const binary = findChromeBinary();
    const profile = debugProfileDir();
    if (!binary) {
      console.error("Google Chrome not found at any standard location.");
      console.error("Set CLAWSTER_CHROME_BIN to override.");
      process.exit(1);
    }
    console.log(launchCmdForDisplay(binary, profile));
  });

const browserInitCmd = new Command("init")
  .description("Launch a dedicated debug Chrome with persistent profile for Playwright-MCP")
  .option("--timeout <seconds>", "Seconds to wait for CDP endpoint", "60")
  .action(async (opts: { timeout: string }) => {
    const timeoutSec = parseInt(opts.timeout, 10) || 60;
    const profile = debugProfileDir();

    console.log("\n=== Clawster browser init ===\n");

    if (await cdpAlive()) {
      const info = await readChromeInfo();
      console.log("  ✓ Debug Chrome already running on the CDP port.");
      if (info?.Browser) console.log(`    ${info.Browser}`);
      console.log(`    Debug profile: ${profile}`);
      console.log("\nNothing more to do. Restricted agents listing");
      console.log('  "mcpServers": ["playwright"]');
      console.log("in agents.json will attach on their next turn.\n");
      return;
    }

    const binary = findChromeBinary();
    if (!binary) {
      console.error("Google Chrome not found at any standard location:");
      console.error("  /Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
      console.error("  /usr/bin/google-chrome  (Linux)");
      console.error("Install Chrome, or set CLAWSTER_CHROME_BIN to the binary path.\n");
      process.exit(1);
    }

    await mkdir(profile, { recursive: true });

    console.log("Launching a dedicated debug Chrome with its own profile.");
    console.log(`  Binary:        ${binary}`);
    console.log(`  Debug profile: ${profile}`);
    console.log(`  CDP port:      ${CDP_PORT}\n`);
    console.log("This is a separate Chrome from your daily browser. On first launch,");
    console.log("you'll need to log into any sites you want agents to reach (Facebook,");
    console.log("KSL, …). Cookies persist in the debug profile, so future runs skip");
    console.log("the login step. Your daily Chrome is untouched.\n");

    const autoLaunch = process.env.CLAWSTER_BROWSER_AUTOLAUNCH !== "0";
    if (!autoLaunch) {
      console.log("Auto-launch disabled (CLAWSTER_BROWSER_AUTOLAUNCH=0).");
      console.log("Run this manually in another terminal:");
      console.log(`  ${launchCmdForDisplay(binary, profile)}\n`);
    } else {
      console.log("Launching... (set CLAWSTER_BROWSER_AUTOLAUNCH=0 to disable)\n");
      // Detached spawn so Chrome survives this CLI exiting. stdio ignored so
      // its window-server chatter doesn't pollute the terminal.
      const child = spawn(binary, buildLaunchArgs(profile), {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
    }

    const deadline = Date.now() + timeoutSec * 1000;
    process.stdout.write(`Waiting up to ${timeoutSec}s for CDP at ${CDP_URL} ...`);
    while (Date.now() < deadline) {
      if (await cdpAlive()) {
        process.stdout.write(" ✓\n");
        const info = await readChromeInfo();
        if (info?.Browser) console.log(`  ${info.Browser}\n`);
        console.log("Setup complete. Restricted agents with playwright in their");
        console.log("mcpServers allowlist will attach on their next turn.");
        console.log("\nNext: in the new Chrome window, log into the sites you want");
        console.log("agents to reach (e.g. facebook.com/marketplace).\n");
        return;
      }
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
    }

    process.stdout.write(" ✗\n");
    console.error(`\nCDP endpoint at ${CDP_URL} did not come up within ${timeoutSec}s.`);
    console.error("Possible causes:");
    console.error(`  • Port ${CDP_PORT} is already in use by another process.`);
    console.error(`    Check: lsof -nP -i :${CDP_PORT}`);
    console.error("  • Chrome binary is wrong. Override with CLAWSTER_CHROME_BIN.");
    console.error(`  • Profile dir is corrupt. Try: rm -rf "${profile}"`);
    console.error("");
    process.exit(1);
  });

export const browserCommand = new Command("browser")
  .description("Manage the Playwright-MCP debug browser")
  .addCommand(browserInitCmd)
  .addCommand(browserStatusCmd)
  .addCommand(browserChromeCmd);
