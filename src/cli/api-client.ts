import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getClawsterHome } from "../core/config.ts";

/**
 * Read the Clawster API bearer token from ~/.clawster/api-token.
 * The daemon writes this on startup; we need it to hit /api/* endpoints.
 */
export async function loadApiToken(): Promise<string> {
  const tokenPath = join(getClawsterHome(), "api-token");
  if (!existsSync(tokenPath)) {
    throw new Error(
      `API token not found at ${tokenPath}. Is Clawster running? Try 'clawster start'.`,
    );
  }
  const token = (await readFile(tokenPath, "utf-8")).trim();
  if (!token) throw new Error(`API token file is empty: ${tokenPath}`);
  return token;
}

/**
 * Resolve the base URL of the running Clawster API. Reads config.json directly
 * rather than via loadConfig() — the full loader validates secrets (bot token)
 * that aren't needed to talk to the local API, and would fail in shells where
 * only the daemon has them.
 */
export async function loadBaseUrl(): Promise<string> {
  let port = 18800;
  try {
    const raw = JSON.parse(await readFile(join(getClawsterHome(), "config.json"), "utf-8"));
    if (typeof raw.healthPort === "number") port = raw.healthPort;
  } catch { /* default port */ }
  return `http://localhost:${port}`;
}
