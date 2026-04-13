import { join } from "path";
import { mkdir, readFile, writeFile, unlink } from "fs/promises";
import type { AgentSession } from "./types.ts";
import { getClawsterHome } from "./config.ts";

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

export async function getSession(agentId: string, topicId?: number): Promise<AgentSession> {
  try {
    const data = await readFile(sessionPath(agentId, topicId), "utf-8");
    return JSON.parse(data) as AgentSession;
  } catch {
    return defaultSession();
  }
}

export async function saveSession(agentId: string, session: AgentSession, topicId?: number): Promise<void> {
  await mkdir(getSessionsDir(), { recursive: true });
  await writeFile(sessionPath(agentId, topicId), JSON.stringify(session, null, 2), "utf-8");
}

export async function clearSession(agentId: string, topicId?: number): Promise<void> {
  try {
    await unlink(sessionPath(agentId, topicId));
  } catch {
    // File doesn't exist — nothing to clear
  }
}
