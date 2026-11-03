import { Command } from "commander";
import { readFile } from "fs/promises";
import { loadApiToken, loadBaseUrl } from "./api-client.ts";

/**
 * `clawster propose` — file a card on the Clawster board's Up next: a known next step, or an idea.
 *
 * Through the daemon's API, like `clawster task`, because the daemon is where the checks live (see
 * src/core/proposal-policy.ts): your own chat only, no links, 2 new cards a day (1 of them an idea), 6 open, dedupe by
 * `dedupe_key`, and a dismissed key blocked for 90 days. Every filing is announced in your own group.
 *
 * The card (JSON):
 *   { "kind": "next" | "idea", "title": "≤80", "summary": "≤280", "why_now": "≤160", "steps": ["≤80", …1-5],
 *     "effort": "S" | "M" | "L", "dedupe_key": "stable-name", "thread": "<your chat id>[:<topic>]",
 *     "decision": { "options": ["≤60", …2-4], "recommended": "one of them" } }   // decision: optional, "next" only
 */
async function api(method: string, path: string, body?: unknown): Promise<any> {
  const [token, baseUrl] = await Promise.all([loadApiToken(), loadBaseUrl()]);
  const resp = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await resp.json().catch(() => ({}));
  if (!resp.ok) {
    console.error(`✗ ${(data as any).error ?? `HTTP ${resp.status}`}`);
    process.exit(1);
  }
  return data;
}

const proposalsPath = (agentId: string) => `/api/agents/${encodeURIComponent(agentId)}/proposals`;

export const proposeCommand = new Command("propose")
  .description("Propose a next step or an idea for Chris's Up next (checked and announced by the daemon)")
  .argument("<agentId>")
  .option("-f, --file <path>", "the card as JSON; use - for stdin")
  .option("--list", "show your proposals and where each stands")
  .action(async (agentId: string, opts: { file?: string; list?: boolean }) => {
    if (opts.list) {
      const { proposals, decisions } = await api("GET", proposalsPath(agentId));
      if (!proposals.length) { console.log(`${agentId} has no proposals.`); return; }
      for (const c of proposals) {
        const d = decisions[c.id];
        console.log(`${c.id}  ${c.kind.padEnd(4)}  ${(d?.status ?? "open").padEnd(10)} ${c.title}`);
      }
      return;
    }
    if (!opts.file) { console.error("✗ Give the card with --file <path> (or --file - for stdin), or use --list."); process.exit(1); }
    const raw = opts.file === "-" ? await Bun.stdin.text() : await readFile(opts.file, "utf-8");
    let card: unknown;
    try { card = JSON.parse(raw); } catch (e) {
      console.error(`✗ ${opts.file} is not valid JSON: ${e instanceof Error ? e.message : e}`);
      process.exit(1);
    }
    const data = await api("POST", proposalsPath(agentId), card);
    console.log(`✓ ${data.action} ${data.proposal.id} (${data.proposal.kind}): ${data.proposal.title}`);
  });
