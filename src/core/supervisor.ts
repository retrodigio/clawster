/**
 * Orchestrator supervision.
 *
 * The daemon keeps a live, interactive Claude Code orchestrator session alive.
 * That session must be interactive: background sessions silently drop channel
 * events, and the channels flag is not preserved in the supervisor's respawn
 * flags (both measured against Claude Code 2.1.220).
 *
 * The hard constraint shaping everything here: **restarting the orchestrator is
 * destructive.** Subagents are keyed by `(session_uuid, agent_id)`, so a restart
 * orphans every live thread. A normal supervisor restarts on any unhealthy
 * signal; this one must restart as rarely as correctness allows, and make the
 * restarts it does perform recoverable.
 *
 * This module is the decision core and is deliberately pure — it takes a
 * snapshot of observations and returns an action. All I/O (running
 * `claude agents --json`, reading the plugin health file, killing, restarting)
 * lives in the caller, so the policy is testable without processes.
 */

/** What the daemon can observe about the orchestrator session. */
export interface SessionObservation {
  /** From `claude agents --json`. Absent when no matching session exists. */
  pid?: number;
  sessionId?: string;
  /** "busy" | "idle" as reported by Claude Code. */
  status?: string;
  /** True when the pid is alive. The caller checks; we don't guess from status. */
  alive: boolean;
}

/**
 * From the channel plugin's health file. The plugin is the only component that
 * knows "an event was delivered and nothing came back" — `status: busy` cannot
 * distinguish working-hard from wedged.
 */
export interface PluginHealth {
  /** epoch ms of the last event handed to the session */
  lastEventDeliveredAt?: number;
  /** epoch ms of the last tool call received from the session */
  lastToolCallAt?: number;
  /** events delivered and not yet answered */
  pendingEvents?: number;
  /** epoch ms the plugin last wrote this file */
  updatedAt?: number;
}

export interface SupervisorConfig {
  /** Silence after a delivered event before we call it wedged. */
  wedgeTimeoutMs: number;
  /** Consecutive wedge readings required before acting. */
  wedgeReadingsRequired: number;
  /** Plugin health older than this is treated as unusable, not as a wedge. */
  healthStaleMs: number;
  /** Restart backoff ladder. */
  backoffMs: number[];
  /** Circuit-break after this many restarts inside circuitWindowMs. */
  maxRestarts: number;
  circuitWindowMs: number;
}

export const DEFAULT_SUPERVISOR_CONFIG: SupervisorConfig = {
  wedgeTimeoutMs: 180_000,
  wedgeReadingsRequired: 2,
  healthStaleMs: 120_000,
  backoffMs: [60_000, 300_000, 900_000, 3_600_000],
  maxRestarts: 3,
  circuitWindowMs: 1_800_000,
};

/** Mutable state the caller carries between ticks. */
export interface SupervisorState {
  consecutiveWedgeReadings: number;
  /** epoch ms of each restart we performed, oldest first. */
  restartTimes: number[];
  /** epoch ms we may next attempt a restart. */
  nextRestartAllowedAt: number;
  /** True once the breaker has tripped; cleared only by an operator. */
  circuitOpen: boolean;
}

export function initialState(): SupervisorState {
  return {
    consecutiveWedgeReadings: 0,
    restartTimes: [],
    nextRestartAllowedAt: 0,
    circuitOpen: false,
  };
}

export type SupervisorAction =
  | { kind: "none"; reason: string }
  | { kind: "start"; reason: string }
  | { kind: "probe"; reason: string }
  | { kind: "restart"; reason: string }
  | { kind: "circuit-open"; reason: string };

export interface Tick {
  now: number;
  session: SessionObservation;
  health?: PluginHealth;
  state: SupervisorState;
  config?: SupervisorConfig;
}

/**
 * Classify the orchestrator. Deliberately conservative: anything we cannot
 * positively establish as wedged is treated as working.
 */
export function classify(
  now: number,
  session: SessionObservation,
  health: PluginHealth | undefined,
  config: SupervisorConfig,
): "dead" | "wedged" | "working" {
  if (!session.alive) return "dead";

  // Without a usable plugin signal we cannot tell wedged from busy. `status`
  // alone is not enough — a session legitimately running a 20-minute subagent
  // looks identical to a stuck one. Prefer a false negative.
  if (!health) return "working";
  if (health.updatedAt !== undefined && now - health.updatedAt > config.healthStaleMs) {
    return "working";
  }

  const delivered = health.lastEventDeliveredAt;
  if (delivered === undefined) return "working";

  // Answered: a tool call landed after the most recent delivery.
  const answered = (health.lastToolCallAt ?? 0) >= delivered;
  if (answered) return "working";

  // Delivered, unanswered, and long enough ago to be a real stall.
  return now - delivered > config.wedgeTimeoutMs ? "wedged" : "working";
}

/**
 * Decide what to do this tick. Pure: returns the action and the next state.
 */
export function decide(tick: Tick): { action: SupervisorAction; state: SupervisorState } {
  const config = tick.config ?? DEFAULT_SUPERVISOR_CONFIG;
  const { now, session, health } = tick;
  const state: SupervisorState = {
    ...tick.state,
    restartTimes: [...tick.state.restartTimes],
  };

  if (state.circuitOpen) {
    return {
      action: {
        kind: "circuit-open",
        reason: "breaker tripped — restarts suspended until an operator clears it",
      },
      state,
    };
  }

  const verdict = classify(now, session, health, config);

  if (verdict !== "wedged") state.consecutiveWedgeReadings = 0;

  // Trim the restart window before counting.
  state.restartTimes = state.restartTimes.filter(t => now - t < config.circuitWindowMs);

  if (verdict === "working") {
    return { action: { kind: "none", reason: "orchestrator is working" }, state };
  }

  // Both remaining verdicts want the process (re)started, so share the guards.
  const isDead = verdict === "dead";

  if (verdict === "wedged") {
    state.consecutiveWedgeReadings += 1;
    if (state.consecutiveWedgeReadings < config.wedgeReadingsRequired) {
      return {
        action: {
          kind: "none",
          reason:
            `wedge reading ${state.consecutiveWedgeReadings}/${config.wedgeReadingsRequired}` +
            ` — waiting for confirmation`,
        },
        state,
      };
    }
    // Confirmed wedge: probe before killing. A session that answers the probe
    // was never wedged, and a false-positive restart costs every live thread.
    if (state.consecutiveWedgeReadings === config.wedgeReadingsRequired) {
      return {
        action: { kind: "probe", reason: "wedge confirmed — probing before restart" },
        state,
      };
    }
  }

  if (state.restartTimes.length >= config.maxRestarts) {
    state.circuitOpen = true;
    return {
      action: {
        kind: "circuit-open",
        reason:
          `${state.restartTimes.length} restarts within ` +
          `${Math.round(config.circuitWindowMs / 60000)}m — stopping. A restart loop ` +
          `orphans subagents faster than an outage you can see.`,
      },
      state,
    };
  }

  if (now < state.nextRestartAllowedAt) {
    return {
      action: {
        kind: "none",
        reason: `backoff — next restart allowed in ${Math.ceil((state.nextRestartAllowedAt - now) / 1000)}s`,
      },
      state,
    };
  }

  const attempt = state.restartTimes.length;
  const backoff = config.backoffMs[Math.min(attempt, config.backoffMs.length - 1)]!;
  state.restartTimes.push(now);
  state.nextRestartAllowedAt = now + backoff;
  state.consecutiveWedgeReadings = 0;

  return {
    action: isDead
      ? { kind: "start", reason: "orchestrator is not running" }
      : { kind: "restart", reason: "wedge confirmed and probe did not clear it" },
    state,
  };
}

/**
 * What gets written before we kill anything.
 *
 * This is the point of the whole design: it turns the successor session's
 * "which session UUID held my orphaned subagents?" from an interactive guess
 * into a deterministic lookup.
 */
export interface RecoveryManifest {
  reason: string;
  killedAt: number;
  sessionId?: string;
  pid?: number;
  subagentsPath?: string;
  teamsConfigPath?: string;
  liveThreadIds: string[];
}

export function buildRecoveryManifest(args: {
  now: number;
  reason: string;
  session: SessionObservation;
  projectHash?: string;
  liveThreadIds: string[];
  home: string;
}): RecoveryManifest {
  const { now, reason, session, projectHash, liveThreadIds, home } = args;
  const manifest: RecoveryManifest = {
    reason,
    killedAt: now,
    sessionId: session.sessionId,
    pid: session.pid,
    liveThreadIds,
  };
  if (session.sessionId && projectHash) {
    manifest.subagentsPath =
      `${home}/.claude/projects/${projectHash}/${session.sessionId}/subagents`;
    // Teams state is keyed by the first 8 chars of the session UUID, and is
    // removed on a clean exit — so it exists only after an ungraceful death,
    // which is most of the cases where recovery is needed.
    manifest.teamsConfigPath =
      `${home}/.claude/teams/session-${session.sessionId.slice(0, 8)}/config.json`;
  }
  return manifest;
}
