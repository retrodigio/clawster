import { Command } from "commander";
import { readFile } from "fs/promises";
import { existsSync } from "fs";
import { join } from "path";
import { getClawsterHome, loadConfig } from "../core/config.ts";

/**
 * Read the Clawster API bearer token from ~/.clawster/api-token.
 * The daemon writes this on startup; we need it to hit /api/* endpoints.
 */
async function loadApiToken(): Promise<string> {
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

/** Resolve the base URL of the running Clawster API (health port from config). */
async function loadBaseUrl(): Promise<string> {
  const cfg = await loadConfig();
  const port = cfg.config.healthPort ?? 18800;
  return `http://localhost:${port}`;
}

export const msgCommand = new Command("msg")
  .description("Send a message to another agent (or broadcast to all agents)")
  .argument("[agentId]", "Target agent ID (omit when using --broadcast)")
  .argument("[message...]", "Message text (quote it, or pass multiple words)")
  .option("-b, --broadcast", "Broadcast to all agents instead of messaging one")
  .option("-f, --from <id>", "Sender agent ID (prefixes message so receiver knows)")
  .option("-w, --wait", "Wait for the receiver's reply and print it (1:1 only)")
  .option("-e, --exclude <ids>", "Comma-separated agent IDs to skip (broadcast only)")
  .option("-t, --topic <id>", "Telegram topic ID for the receiver (1:1 only)", (v) => Number(v))
  .action(
    async (
      agentId: string | undefined,
      messageParts: string[],
      opts: {
        broadcast?: boolean;
        from?: string;
        wait?: boolean;
        exclude?: string;
        topic?: number;
      },
    ) => {
      // Validate args up front
      if (opts.broadcast) {
        // In broadcast mode the first positional is part of the message, not an agent ID.
        if (agentId) messageParts = [agentId, ...messageParts];
        agentId = undefined;
      }

      const message = messageParts.join(" ").trim();
      if (!message) {
        console.error("Message is required.");
        process.exit(1);
      }

      const token = await loadApiToken();
      const baseUrl = await loadBaseUrl();
      const headers = {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      };

      if (opts.broadcast) {
        const exclude = opts.exclude
          ? opts.exclude.split(",").map((s) => s.trim()).filter(Boolean)
          : undefined;
        const resp = await fetch(`${baseUrl}/api/agents/broadcast`, {
          method: "POST",
          headers,
          body: JSON.stringify({
            message,
            from: opts.from,
            exclude,
          }),
        });
        const data = await resp.json().catch(() => ({}));
        if (!resp.ok) {
          console.error(`Broadcast failed (${resp.status}):`, data);
          process.exit(1);
        }
        console.log(
          `Broadcast dispatched to ${(data as any).delivered?.length ?? 0} agent(s)` +
            ((data as any).skipped?.length
              ? ` (skipped: ${(data as any).skipped.join(", ")})`
              : ""),
        );
        return;
      }

      if (!agentId) {
        console.error("Agent ID is required (or pass --broadcast).");
        process.exit(1);
      }

      const resp = await fetch(
        `${baseUrl}/api/agents/${encodeURIComponent(agentId)}/message`,
        {
          method: "POST",
          headers,
          body: JSON.stringify({
            message,
            from: opts.from,
            topicId: opts.topic,
            wait: opts.wait ?? false,
          }),
        },
      );
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        console.error(`Message failed (${resp.status}):`, data);
        process.exit(1);
      }

      if (opts.wait) {
        const text = (data as any).text ?? "";
        console.log(text);
      } else {
        console.log(`Message dispatched to ${agentId}.`);
      }
    },
  );
