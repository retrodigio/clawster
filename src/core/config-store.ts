import { loadConfig, saveAgents, type LoadedConfig, type AgentsConfig } from "./config.ts";
import type { AgentConfig } from "./types.ts";
import { log } from "./logger.ts";

/**
 * Single source of truth for runtime config.
 *
 * Before this existed, server.ts, router.ts, and the scheduler each held their
 * own snapshot of the loaded config: a web-API agent edit updated the file and
 * the server's copy, while Telegram routing and heartbeats kept stale objects
 * until restart — and two writers could clobber each other's agents.json.
 *
 * Invariants:
 *  - `chatIdToAgent` and `agentById` are STABLE Map instances, refilled in
 *    place on reload. Long-lived holders (bot handler deps) never go stale.
 *  - All agents.json writes go through `mutateAgents`, which serializes them,
 *    mutates a clone (so a validation failure leaves memory untouched),
 *    validates + writes atomically, then reloads and notifies listeners.
 */

let current: LoadedConfig | null = null;
const listeners = new Set<(cfg: LoadedConfig) => void>();

// Stable map instances — see invariants above.
const stableChatIdToAgent = new Map<string, AgentConfig>();
const stableAgentById = new Map<string, AgentConfig>();

// Serializes mutateAgents calls so concurrent writers can't interleave.
let writeChain: Promise<unknown> = Promise.resolve();

function applyLoaded(cfg: LoadedConfig): LoadedConfig {
  stableChatIdToAgent.clear();
  for (const [k, v] of cfg.chatIdToAgent) stableChatIdToAgent.set(k, v);
  stableAgentById.clear();
  for (const [k, v] of cfg.agentById) stableAgentById.set(k, v);
  current = { ...cfg, chatIdToAgent: stableChatIdToAgent, agentById: stableAgentById };
  return current;
}

export async function initConfigStore(): Promise<LoadedConfig> {
  return applyLoaded(await loadConfig());
}

export function getConfig(): LoadedConfig {
  if (!current) throw new Error("Config store not initialized — call initConfigStore() first");
  return current;
}

/** Subscribe to config changes. Returns an unsubscribe function. */
export function onConfigChange(fn: (cfg: LoadedConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Re-read config from disk and notify all listeners (router re-init, etc.). */
export async function reloadConfigStore(): Promise<LoadedConfig> {
  const cfg = applyLoaded(await loadConfig());
  for (const fn of listeners) {
    try {
      fn(cfg);
    } catch (err) {
      log.error("config", "Config-change listener failed", { error: String(err) });
    }
  }
  return cfg;
}

/**
 * Serialized, validated mutation of agents.json.
 *
 * The mutator receives a CLONE of the current agents config. If it (or schema
 * validation inside saveAgents) throws, nothing changes — neither on disk nor
 * in memory. On success the store reloads from disk, so in-memory state always
 * reflects exactly what was persisted.
 */
export async function mutateAgents(
  mutator: (agents: AgentsConfig) => void | Promise<void>,
): Promise<LoadedConfig> {
  const task = writeChain.then(async () => {
    const clone = structuredClone(getConfig().agents);
    await mutator(clone);
    await saveAgents(clone); // validates schema + atomic write
    return reloadConfigStore();
  });
  // Keep the chain alive even when a mutation fails.
  writeChain = task.catch(() => {});
  return task;
}
