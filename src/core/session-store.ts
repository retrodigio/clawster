import { join } from "path";
import { mkdir, readFile, readdir, rename, unlink } from "fs/promises";
import type { AgentSession } from "./types.ts";
import { getClawsterHome } from "./config.ts";
import { log } from "./logger.ts";

function getSessionsDir(): string {
  return join(getClawsterHome(), "sessions");
}

export function getSessionKey(agentId: string, topicId?: number): string {
  if (topicId !== undefined) {
    return `${agentId}-topic-${topicId}`;
  }
  return agentId;
}

function sessionPath(agentId: string, topicId?: number): string {
  return join(getSessionsDir(), `${getSessionKey(agentId, topicId)}.json`);
}

function defaultSession(): AgentSession {
  return {
    sessionId: null,
    lastActivity: new Date().toISOString(),
    lastHeartbeat: null,
    messageCount: 0,
  };
}

function tryParseSession(data: string): AgentSession | null {
  try {
    return JSON.parse(data) as AgentSession;
  } catch {
    return null;
  }
}

export async function getSession(agentId: string, topicId?: number): Promise<AgentSession> {
  const filePath = sessionPath(agentId, topicId);
  const tmpPath = `${filePath}.tmp`;

  // Try the main session file first
  try {
    const data = await readFile(filePath, "utf-8");
    const session = tryParseSession(data);
    if (session) return session;
    log.warn("session", `Corrupt session file, attempting recovery from .tmp`, { path: filePath });
  } catch {
    // File doesn't exist — fall through to tmp recovery
  }

  // Try the .tmp file as a recovery fallback
  try {
    const data = await readFile(tmpPath, "utf-8");
    const session = tryParseSession(data);
    if (session) {
      log.info("session", `Recovered session from .tmp file`, { path: tmpPath });
      return session;
    }
    log.warn("session", `Both session file and .tmp are corrupt`, { path: filePath });
  } catch {
    // .tmp doesn't exist either — return default
  }

  return defaultSession();
}

export async function saveSession(agentId: string, session: AgentSession, topicId?: number): Promise<void> {
  await mkdir(getSessionsDir(), { recursive: true });
  const filePath = sessionPath(agentId, topicId);
  const tmpPath = `${filePath}.tmp`;
  // Write to temp file first, then atomic rename
  await Bun.write(tmpPath, JSON.stringify(session, null, 2));
  await rename(tmpPath, filePath);
}

export async function getAllSessions(): Promise<Map<string, AgentSession>> {
  const sessions = new Map<string, AgentSession>();
  const dir = getSessionsDir();

  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return sessions;
  }

  for (const file of files) {
    if (!file.endsWith(".json") || file.endsWith(".tmp.json")) continue;
    const key = file.replace(/\.json$/, "");
    try {
      const data = await readFile(join(dir, file), "utf-8");
      const session = tryParseSession(data);
      if (session) {
        sessions.set(key, session);
      } else {
        log.warn("session", `Skipping corrupt session file`, { path: join(dir, file) });
      }
    } catch {
      // Skip unreadable files
    }
  }

  return sessions;
}

export async function clearSession(agentId: string, topicId?: number): Promise<void> {
  try {
    await unlink(sessionPath(agentId, topicId));
  } catch {
    // File doesn't exist — nothing to clear
  }
}
