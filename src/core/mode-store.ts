import { join } from "path";
import { mkdir, readFile, rename, unlink } from "fs/promises";
import type { AgentMode } from "./types.ts";
import { getClawsterHome } from "./config.ts";
import { log } from "./logger.ts";

/**
 * Per-chat model mode persistence.
 *
 * A "mode" (planning | implementation) picks which model line an agent drives
 * for a given chat/topic. It's set by /plan and /build and read by the runner's
 * resolveModel. Persisted so a mode survives restarts — the same way sessions
 * do — keyed by agentId (+ topicId), each in its own file for atomic writes.
 *
 * Absence of a file means "no explicit mode": the runner falls back to the
 * agent's defaultMode, then to "implementation".
 */

function getModesDir(): string {
  return join(getClawsterHome(), "modes");
}

function modeKey(agentId: string, topicId?: number): string {
  return topicId !== undefined ? `${agentId}-topic-${topicId}` : agentId;
}

function modePath(agentId: string, topicId?: number): string {
  return join(getModesDir(), `${modeKey(agentId, topicId)}.json`);
}

function isMode(v: unknown): v is AgentMode {
  return v === "conversation" || v === "planning" || v === "implementation";
}

/** Returns the stored mode, or null when none has been set for this chat. */
export async function getMode(agentId: string, topicId?: number): Promise<AgentMode | null> {
  try {
    const data = await readFile(modePath(agentId, topicId), "utf-8");
    const parsed = JSON.parse(data) as { mode?: unknown };
    if (isMode(parsed.mode)) return parsed.mode;
  } catch {
    // Missing or corrupt — treat as unset.
  }
  return null;
}

export async function setMode(agentId: string, mode: AgentMode, topicId?: number): Promise<void> {
  await mkdir(getModesDir(), { recursive: true });
  const filePath = modePath(agentId, topicId);
  const tmpPath = `${filePath}.tmp`;
  await Bun.write(tmpPath, JSON.stringify({ mode }, null, 2));
  await rename(tmpPath, filePath);
  log.info("mode", "Mode set", { agentId, topicId: topicId ?? null, mode });
}

export async function clearMode(agentId: string, topicId?: number): Promise<void> {
  const filePath = modePath(agentId, topicId);
  try {
    await unlink(filePath);
  } catch {
    // Nothing to clear.
  }
  try {
    await unlink(`${filePath}.tmp`);
  } catch {
    // No recovery file.
  }
}
