import { Command } from "commander";
import { spawnSync } from "child_process";

const CDP_PORT = 9222;
const CDP_URL = `http://localhost:${CDP_PORT}`;
const CHROME_LAUNCH_CMD = `open -a "Google Chrome" --args --remote-debugging-port=${CDP_PORT}`;

async function cdpAlive(timeoutMs = 1500): Promise<boolean> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return resp.ok;
  } catch {
    return false;
  }
}

async function readChromeInfo(): Promise<Record<string, unknown> | null> {
  try {
    const resp = await fetch(`${CDP_URL}/json/version`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return null;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

const browserStatusCmd = new Command("status")
  .description("Check whether Chrome is reachable on the CDP debug port")
  .action(async () => {
    console.log(`\nChecking ${CDP_URL}/json/version ...\n`);
    const info = await readChromeInfo();
    if (!info) {
      console.log(`  ✗ No CDP endpoint at ${CDP_URL}.`);
      console.log("  → Launch Chrome with remote debugging:");
      console.log(`      ${CHROME_LAUNCH_CMD}`);
      console.log("  → Or run: clawster browser init");
      process.exit(1);
    }
    console.log("  ✓ CDP endpoint live.");
    console.log(`    Browser:           ${info.Browser ?? "(unknown)"}`);
    console.log(`    Protocol-Version:  ${info["Protocol-Version"] ?? "?"}`);
    console.log(`    User-Agent:        ${info["User-Agent"] ?? "?"}`);
    console.log("");
  });

const browserChromeCmd = new Command("chrome")
  .description("Print the Chrome launch command (for copy/paste)")
  .action(() => {
    console.log(CHROME_LAUNCH_CMD);
  });

const browserInitCmd = new Command("init")
  .description("Walk through first-time Chrome + Playwright-MCP setup")
  .option("--timeout <seconds>", "Seconds to wait for CDP endpoint", "120")
  .action(async (opts: { timeout: string }) => {
    const timeoutSec = parseInt(opts.timeout, 10) || 120;

    console.log("\n=== Clawster browser init ===\n");

    // Step 1: already running?
    if (await cdpAlive()) {
      const info = await readChromeInfo();
      console.log("  ✓ Chrome already reachable on the CDP debug port.");
      if (info?.Browser) console.log(`    ${info.Browser}`);
      console.log("");
      console.log("Nothing more to do. Restricted agents that list");
      console.log('  "mcpServers": ["playwright"]');
      console.log("in agents.json will attach to this Chrome on their next turn.\n");
      return;
    }

    // Step 2: tell the user to launch
    console.log("Chrome is not running with remote debugging enabled.");
    console.log("\nLaunch it with:");
    console.log(`  ${CHROME_LAUNCH_CMD}\n`);
    console.log("Tip: this will reuse your default Chrome profile, so anywhere");
    console.log("you're logged in (Facebook, KSL, Gmail, banking, …) is now");
    console.log("reachable by any Clawster agent that opts into the playwright");
    console.log("MCP. Keep that blast radius in mind.\n");

    const tryAutoLaunch =
      process.platform === "darwin" && process.env.CLAWSTER_BROWSER_AUTOLAUNCH !== "0";
    if (tryAutoLaunch) {
      console.log("Auto-launching Chrome for you (set CLAWSTER_BROWSER_AUTOLAUNCH=0 to disable)...");
      const res = spawnSync("open", ["-a", "Google Chrome", "--args", `--remote-debugging-port=${CDP_PORT}`], {
        stdio: "inherit",
      });
      if (res.status !== 0) {
        console.log("  (auto-launch failed; please run the command above manually)");
      }
    }

    // Step 3: wait for CDP
    const deadline = Date.now() + timeoutSec * 1000;
    process.stdout.write(`\nWaiting up to ${timeoutSec}s for CDP at ${CDP_URL} ...`);
    while (Date.now() < deadline) {
      if (await cdpAlive()) {
        process.stdout.write(" ✓\n");
        const info = await readChromeInfo();
        if (info?.Browser) console.log(`  ${info.Browser}\n`);
        console.log("Setup complete. Restricted agents with playwright in their");
        console.log("mcpServers allowlist will attach on their next turn.\n");
        return;
      }
      process.stdout.write(".");
      await new Promise((r) => setTimeout(r, 1000));
    }

    process.stdout.write(" ✗\n");
    console.error(`\nCDP endpoint at ${CDP_URL} did not come up within ${timeoutSec}s.`);
    console.error("Possible causes:");
    console.error("  • Chrome was already running without --remote-debugging-port.");
    console.error("    Quit Chrome completely (⌘Q), then re-run this command.");
    console.error("  • Wrong Chrome binary. Edit src/cli/browser.ts CHROME_LAUNCH_CMD.");
    console.error("");
    process.exit(1);
  });

export const browserCommand = new Command("browser")
  .description("Manage the Playwright-MCP browser integration")
  .addCommand(browserInitCmd)
  .addCommand(browserStatusCmd)
  .addCommand(browserChromeCmd);
