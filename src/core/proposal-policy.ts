/**
 * The rules for an agent proposing what it could do next (Up next; the spec is kb-claude-surface wiki/up-next-spec.md,
 * approved by Chris on 2026-11-02).
 *
 * A proposal is a card on the Clawster board's Up next surface: a known next step, or an idea. Agents file them with
 * `clawster propose`, which goes through the daemon so that these checks hold whatever an agent was talked into, and so
 * scheduled passes (`claude -p`, no board tools) can file too. The daemon appends the card to
 * `~/.clawster/proposals/<agent>.jsonl`; fleet-sync draws it; Chris's decisions come back through the orchestrator into
 * `proposals-state.json`, which this module only reads.
 *
 * What the checks guard against:
 *  - **Noise.** At most 2 new cards a day per agent, at most 1 of them an idea, and 6 open at once (Chris's numbers).
 *    A card with the same `dedupe_key` as an open one replaces it instead of adding one, and does not count as new.
 *    A dismissed key is blocked for 90 days, and a title that nearly matches an open or recently dismissed card is refused.
 *  - **Cross-chat work.** A card's `thread` must be the agent's own chat (or a topic in it): Start routes there.
 *  - **Leaks onto a page.** No links, no Telegram addresses and nothing that looks like a token in any field. The board
 *    shows these fields; a private project's title also becomes a private term on the Mac.
 *
 * Every new card is announced in the agent's own group as a new message (`describeProposal`), like a schedule change.
 */
import type { AgentConfig } from "./types.ts";

export const MAX_NEW_PER_DAY = 2;
export const MAX_IDEAS_PER_DAY = 1;
export const MAX_OPEN = 6;
export const DAY_MS = 86_400_000;
export const DISMISSED_BLOCK_MS = 90 * DAY_MS;
export const EXPIRY_MS = { next: 7 * DAY_MS, idea: 21 * DAY_MS } as const;

export type ProposalKind = "next" | "idea";
export type Proposal = {
  id: string; agent: string; thread: string; kind: ProposalKind; title: string; summary: string; why_now: string;
  steps: string[]; effort: "S" | "M" | "L"; decision?: { options: string[]; recommended: string | null };
  dedupe_key: string; created_ms: number; expires_ms: number;
};
export type Decision = { status: "open" | "started" | "snoozed" | "dismissed" | "discussing"; until_ms?: number; at_ms?: number };
export type ProposalCheck = { ok: true; card: Proposal; replaced: boolean } | { ok: false; error: string };

const LINK = /(https?:\/\/|www\.|t\.me\/|telegram\.me\/|\b[a-z0-9-]+\.(com|net|org|io|app|dev|co)\b)/i;
const TOKEN = /\b[A-Za-z0-9_-]{32,}\b|\b\d{8,}:[A-Za-z0-9_-]{20,}\b|\bsk-[A-Za-z0-9]/;
const CONTROL = /[\u0000-\u001f\u007f]/;

function field(raw: unknown, name: string, max: number, required: boolean): { ok: true; v: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") return required ? { ok: false, error: `"${name}" is required` } : { ok: true, v: "" };
  if (typeof raw !== "string") return { ok: false, error: `"${name}" must be text` };
  const v = raw.trim();
  if (CONTROL.test(v)) return { ok: false, error: `"${name}" must be one line of plain text` };
  if (v.length > max) return { ok: false, error: `"${name}" is ${v.length} characters; the limit is ${max}` };
  if (required && !v) return { ok: false, error: `"${name}" is required` };
  if (LINK.test(v)) return { ok: false, error: `"${name}" contains a link or address; proposals carry plain words only` };
  if (TOKEN.test(v)) return { ok: false, error: `"${name}" contains something that looks like a token or id; leave it out` };
  return { ok: true, v };
}

/** Words of a title, for the near-duplicate check. */
const words = (t: string) => new Set(t.toLowerCase().replace(/[^a-z0-9 ]+/g, " ").split(/\s+/).filter((w) => w.length > 2));
export function nearlySame(a: string, b: string): boolean {
  const x = words(a), y = words(b);
  if (!x.size || !y.size) return a.trim().toLowerCase() === b.trim().toLowerCase();
  let both = 0;
  for (const w of x) if (y.has(w)) both++;
  return both / (x.size + y.size - both) >= 0.8;
}

/** Where a card stands (same rule as the board's fleet-sync): open, started, snoozed, or gone (dismissed or expired). */
export function standing(c: Proposal, d: Decision | undefined, now: number): "open" | "started" | "snoozed" | "gone" {
  const s = d?.status ?? "open";
  if (s === "dismissed") return "gone";
  if (s === "started") return "started";
  if (s === "snoozed" && (d?.until_ms ?? 0) > now) return "snoozed";
  if (s !== "discussing" && now > c.expires_ms) return "gone";
  return "open";
}

export function newProposalId(now: number, rand: () => number = Math.random): string {
  const d = new Date(now);
  const ymd = `${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}`;
  return `p${ymd}-${Math.floor(rand() * 0x10000).toString(16).padStart(4, "0")}`;
}

/**
 * Check one card an agent wants to file, against its existing cards (the last line per id) and Chris's decisions.
 * On success the card has its id, timestamps and expiry; `replaced` means it takes an open card's place (same dedupe_key).
 */
export function checkProposal(
  agent: AgentConfig, raw: unknown, existing: Proposal[], decisions: Record<string, Decision>, now: number,
  rand: () => number = Math.random,
): ProposalCheck {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "A proposal is one JSON object" };
  const b = raw as Record<string, unknown>;
  const kind = b.kind === "next" || b.kind === "idea" ? b.kind : null;
  if (!kind) return { ok: false, error: '"kind" must be "next" (known work) or "idea"' };

  const parts: Record<string, string> = {};
  for (const [name, max, required] of [["title", 80, true], ["summary", 280, true], ["why_now", 160, true], ["dedupe_key", 64, true], ["thread", 80, false]] as const) {
    const r = field(b[name], name, max, required);
    if (!r.ok) return r;
    parts[name] = r.v;
  }
  if (!/^[a-z0-9][a-z0-9_.:-]{0,63}$/i.test(parts.dedupe_key!)) return { ok: false, error: '"dedupe_key" is a short stable name: letters, digits, - _ . :' };

  // The card's thread is the agent's own chat or a topic in it: Start sends the go there.
  const own = String(agent.telegramChatId);
  const thread = parts.thread || own;
  const [chat, topic, extra] = thread.split(":");
  if (chat !== own || extra !== undefined || (topic !== undefined && !/^\d{1,10}$/.test(topic))) {
    return { ok: false, error: `"thread" must be your own chat (${own}) or one of its topics (${own}:<topic>)` };
  }

  if (!Array.isArray(b.steps) || b.steps.length < 1 || b.steps.length > 5) return { ok: false, error: '"steps" is a list of 1 to 5 short lines' };
  const steps: string[] = [];
  for (const [i, s] of b.steps.entries()) {
    const r = field(s, `steps[${i}]`, 80, true);
    if (!r.ok) return r;
    steps.push(r.v);
  }
  const effort = b.effort === "S" || b.effort === "M" || b.effort === "L" ? b.effort : null;
  if (!effort) return { ok: false, error: '"effort" is S (under an hour), M (a session) or L (several)' };

  let decision: Proposal["decision"];
  if (b.decision !== undefined && b.decision !== null) {
    if (kind !== "next") return { ok: false, error: 'Only a "next" card can carry a decision' };
    const d = b.decision as Record<string, unknown>;
    if (!Array.isArray(d.options) || d.options.length < 2 || d.options.length > 4) return { ok: false, error: '"decision.options" is 2 to 4 choices' };
    const options: string[] = [];
    for (const [i, o] of d.options.entries()) {
      const r = field(o, `decision.options[${i}]`, 60, true);
      if (!r.ok) return r;
      if (options.includes(r.v)) return { ok: false, error: "decision options must differ" };
      options.push(r.v);
    }
    const rec = d.recommended ?? null;
    if (rec !== null && (typeof rec !== "string" || !options.includes(rec))) return { ok: false, error: '"decision.recommended" must be one of the options, or left out' };
    decision = { options, recommended: rec };
  }

  const mine = existing.filter((c) => c.agent === agent.id);
  const live = mine.filter((c) => { const s = standing(c, decisions[c.id], now); return s === "open" || s === "snoozed" || s === "started"; });
  const openNow = mine.filter((c) => { const s = standing(c, decisions[c.id], now); return s === "open" || s === "snoozed"; });
  const same = openNow.find((c) => c.dedupe_key === parts.dedupe_key);

  if (!same) {
    const blocked = mine.find((c) => c.dedupe_key === parts.dedupe_key && decisions[c.id]?.status === "dismissed" && now - (decisions[c.id]?.at_ms ?? c.created_ms) < DISMISSED_BLOCK_MS);
    if (blocked) return { ok: false, error: `Chris dismissed "${blocked.title}" (the same dedupe_key); it can't come back for 90 days` };
    const recentDismissed = mine.filter((c) => decisions[c.id]?.status === "dismissed" && now - (decisions[c.id]?.at_ms ?? c.created_ms) < DISMISSED_BLOCK_MS);
    const twin = [...live, ...recentDismissed].find((c) => nearlySame(c.title, parts.title!));
    if (twin) return { ok: false, error: `"${parts.title}" nearly matches "${twin.title}", which is ${decisions[twin.id]?.status === "dismissed" ? "dismissed" : "already on the board"}. Use its dedupe_key to update it, or propose something different` };
    if (openNow.length >= MAX_OPEN) return { ok: false, error: `You have ${openNow.length} open proposals, the limit. Let Chris act on those first` };
    const today = mine.filter((c) => now - c.created_ms < DAY_MS);
    if (today.length >= MAX_NEW_PER_DAY) return { ok: false, error: `You filed ${today.length} proposals in the last 24 hours, the limit` };
    if (kind === "idea" && today.some((c) => c.kind === "idea")) return { ok: false, error: "You filed an idea in the last 24 hours; one a day" };
  }

  const created = same ? same.created_ms : now;
  const card: Proposal = {
    id: same ? same.id : newProposalId(now, rand), agent: agent.id, thread, kind, title: parts.title!, summary: parts.summary!,
    why_now: parts.why_now!, steps, effort, ...(decision ? { decision } : {}), dedupe_key: parts.dedupe_key!,
    created_ms: created, expires_ms: now + EXPIRY_MS[kind],
  };
  return { ok: true, card, replaced: !!same };
}

/** The last line per id, from a proposals file's text. Unparseable lines are skipped. */
export function parseProposals(text: string): Proposal[] {
  const byId = new Map<string, Proposal>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try { const c = JSON.parse(line); if (c && typeof c.id === "string") byId.set(c.id, c as Proposal); } catch { /* skip */ }
  }
  return [...byId.values()];
}

/** The notice in the agent's own group: a new message, so Chris sees what went on his board. */
export function describeProposal(agent: AgentConfig, card: Proposal, replaced: boolean): string {
  const what = card.kind === "idea" ? "an idea" : "a next step";
  return `${replaced ? "📝 Updated" : "💡 New"} on the board's Up next — ${agent.name} proposes ${what}: ${card.title}`;
}
