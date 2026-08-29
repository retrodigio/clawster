/**
 * Journal of unprompted outbound messages.
 *
 * A scheduled wake is a fresh `claude -p` process with no memory of the last
 * one and no plugin tools. That produces two failures the conduct standard
 * (`clawster-orchestrator/prompts/conduct.md`) cannot fix on its own:
 *
 *   1. Repetition. Wake N has no idea wake N-1 already reported the red build.
 *   2. Ambiguous silence. `NO_CHECKIN` is binary and memoryless, so it cannot
 *      distinguish "nothing happened" from "still blocked". Conduct §8 forbids
 *      `NO_CHECKIN` while a previously-reported blocker stands — but an agent
 *      can only obey that rule if it can see what it previously reported.
 *
 * So: one line per message the agent sent that nobody asked for. Written by the
 * scheduler after a successful send, read back into the next wake's prompt.
 *
 * Deliberately not a general message log. Replies to a human are not journaled
 * — they were solicited, the human has them on screen, and they are not the
 * thing an agent needs to avoid repeating.
 */

import { join } from "path";
import { readFile, writeFile, appendFile, mkdir } from "fs/promises";
import { existsSync } from "fs";
import { getClawsterHome } from "./config.ts";
import { log } from "./logger.ts";

/** Entries kept per agent. Older lines are dropped on write. */
const MAX_ENTRIES = 200;

/** How much of the message body is kept as the recognisable "claim". */
const CLAIM_CHARS = 240;

export interface JournalEntry {
  /** ISO-8601 UTC. */
  ts: string;
  agentId: string;
  /** The scheduled task that produced it — "heartbeat", "check", "assess". */
  task: string;
  chatId: string;
  topicId?: number;
  /** Telegram message id of the FIRST chunk — the citable anchor. */
  messageId: number;
  /** t.me permalink, when the chat id is a supergroup. */
  permalink?: string;
  /** Opening of the message, flattened to one line. */
  claim: string;
}

export function getJournalDir(): string {
  return join(getClawsterHome(), "journal");
}

function journalPath(agentId: string): string {
  return join(getJournalDir(), `${agentId}.jsonl`);
}

/**
 * Build a t.me permalink for a message.
 *
 * Only supergroups (chat ids prefixed `-100`) have them; private groups and
 * DMs are not addressable this way, so those return undefined rather than a
 * link that 404s.
 */
export function telegramPermalink(
  chatId: string,
  messageId: number,
  topicId?: number,
): string | undefined {
  if (!chatId.startsWith("-100")) return undefined;
  const internal = chatId.slice(4);
  if (!/^\d+$/.test(internal)) return undefined;
  return topicId
    ? `https://t.me/c/${internal}/${topicId}/${messageId}`
    : `https://t.me/c/${internal}/${messageId}`;
}

/** Collapse a multi-line message into a single recognisable line. */
function toClaim(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > CLAIM_CHARS ? `${flat.slice(0, CLAIM_CHARS - 1)}…` : flat;
}

export async function appendOutbound(
  entry: Omit<JournalEntry, "ts" | "claim" | "permalink"> & { text: string },
): Promise<void> {
  const record: JournalEntry = {
    ts: new Date().toISOString(),
    agentId: entry.agentId,
    task: entry.task,
    chatId: entry.chatId,
    ...(entry.topicId ? { topicId: entry.topicId } : {}),
    messageId: entry.messageId,
    ...(() => {
      const link = telegramPermalink(entry.chatId, entry.messageId, entry.topicId);
      return link ? { permalink: link } : {};
    })(),
    claim: toClaim(entry.text),
  };

  try {
    await mkdir(getJournalDir(), { recursive: true });
    const path = journalPath(entry.agentId);
    await appendFile(path, `${JSON.stringify(record)}\n`, "utf-8");
    await trim(path);
  } catch (err) {
    // A journal write must never cost a delivered message. The send already
    // happened; losing the record is a degradation, not a failure.
    log.warn(entry.agentId, "Failed to append outbound journal entry", { error: String(err) });
  }
}

/** Keep the file bounded. Cheap because it only rewrites past the ceiling. */
async function trim(path: string): Promise<void> {
  const lines = (await readFile(path, "utf-8")).split("\n").filter(Boolean);
  if (lines.length <= MAX_ENTRIES) return;
  await writeFile(path, `${lines.slice(-MAX_ENTRIES).join("\n")}\n`, "utf-8");
}

/** Most recent entries for an agent, oldest first. Never throws. */
export async function readRecentOutbound(agentId: string, limit = 8): Promise<JournalEntry[]> {
  const path = journalPath(agentId);
  if (!existsSync(path)) return [];
  try {
    const lines = (await readFile(path, "utf-8")).split("\n").filter(Boolean);
    return lines
      .slice(-limit)
      .map((line) => {
        try {
          return JSON.parse(line) as JournalEntry;
        } catch {
          return null;
        }
      })
      .filter((e): e is JournalEntry => e !== null);
  } catch (err) {
    log.warn(agentId, "Failed to read outbound journal", { error: String(err) });
    return [];
  }
}

/**
 * Render the journal as a prompt block.
 *
 * This is the operative half of conduct §8: an agent can only honour "do not
 * go silent on an unresolved blocker" if it can see what it last claimed. The
 * instructions are stated here rather than in each task's prompt so every
 * scheduled wake gets them, including hand-written `tasks[]` entries.
 */
export function formatJournalForPrompt(entries: JournalEntry[], timezone: string): string {
  if (entries.length === 0) return "";

  const lines = entries.map((e) => {
    const when = new Date(e.ts).toLocaleString("en-US", {
      timeZone: timezone,
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    });
    const where = e.permalink ?? `message ${e.messageId}`;
    return `- ${when} (${e.task}) · ${where}\n  "${e.claim}"`;
  });

  return [
    "YOUR RECENT UNPROMPTED MESSAGES — oldest first",
    "",
    "These are messages you sent to this group on earlier scheduled wakes. Nobody",
    "asked for them; you decided each one was worth interrupting for.",
    "",
    lines.join("\n"),
    "",
    "Use them:",
    "- Do not repeat something already said here. Repetition reads as noise and",
    "  trains Chris to ignore you.",
    "- If your most recent entry reported a blocker and it is STILL blocked,",
    "  NO_CHECKIN is forbidden. Silence after a reported problem is ambiguous —",
    "  it reads as either \"fixed\" or \"the agent is dead\". Post the state change,",
    "  or post that there is none, and link the original message above.",
    "- To refer back to one of these, link it. Do not restate it.",
  ].join("\n");
}
