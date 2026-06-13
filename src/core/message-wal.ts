import { join } from "path";
import { mkdir, readdir, readFile, unlink, writeFile } from "fs/promises";
import { getClawsterHome } from "./config.ts";
import { log } from "./logger.ts";

/**
 * Inbound-message write-ahead log.
 *
 * grammY acks a Telegram update (the offset advances) as soon as it's
 * dispatched, so a process death between receipt and reply loses the message
 * silently — launchd restarts the daemon, but the in-flight turn evaporates.
 *
 * Each accepted message gets a small file here; the file is removed once the
 * handler finishes (reply sent, or an error reply shown — either way the user
 * got feedback). On startup, leftover files are orphans: the server notifies
 * the owner in the originating chat so nothing disappears without a trace.
 */

export interface WalEntry {
  id: string;
  chatId: string;
  topicId?: number;
  agentId: string;
  text: string;
  receivedAt: string;
}

function walDir(): string {
  return join(getClawsterHome(), "wal");
}

/** Record an accepted message. Returns the entry id to pass to walDone(). */
export async function walAppend(entry: Omit<WalEntry, "id">): Promise<string> {
  const id = crypto.randomUUID();
  try {
    await mkdir(walDir(), { recursive: true });
    await writeFile(join(walDir(), `${id}.json`), JSON.stringify({ id, ...entry }, null, 2));
  } catch (err) {
    // The WAL is belt-and-suspenders — never let it break message handling.
    log.warn("wal", "Failed to append WAL entry", { error: String(err) });
  }
  return id;
}

/** Mark a message handled (user received a reply or an error notice). */
export async function walDone(id: string): Promise<void> {
  try {
    await unlink(join(walDir(), `${id}.json`));
  } catch {
    // Already removed — fine
  }
}

/** Read all unhandled entries (used at startup to detect orphans). */
export async function walPending(): Promise<WalEntry[]> {
  let files: string[];
  try {
    files = await readdir(walDir());
  } catch {
    return [];
  }
  const entries: WalEntry[] = [];
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const entry = JSON.parse(await readFile(join(walDir(), f), "utf-8")) as WalEntry;
      if (entry?.id && entry?.chatId) entries.push(entry);
    } catch {
      // Corrupt entry — drop it rather than crash startup
      await unlink(join(walDir(), f)).catch(() => {});
    }
  }
  return entries;
}
