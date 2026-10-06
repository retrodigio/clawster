/**
 * Tailscale Funnel supervision — the decision core.
 *
 * External sites (IronRod's Railway server, LetterGnome on Vercel) reach this
 * Mac through a Tailscale Funnel to the daemon's hook endpoints. When Tailscale
 * stops, nothing on this machine notices: the IronRod feedback pipeline was
 * silently dead from 2026-06-22 until someone went looking months later. This
 * module turns "is the tunnel serving?" into a decision the daemon acts on.
 *
 * Same split as supervisor.ts: this file is pure — observation + state in,
 * action + state out — and tunnel-monitor.ts does the I/O. The interesting
 * questions (when to retry, when to speak, when to stay quiet) are therefore
 * testable without Tailscale.
 *
 * What it can and cannot fix, without sudo:
 *   app not running      → launch Tailscale.app
 *   backend Stopped      → `tailscale up` (no flags — reuses saved prefs)
 *   funnel config gone   → re-apply the funnel for the hook path
 *   NeedsLogin           → nothing. Login is interactive; retrying only mints
 *                          fresh auth URLs. Alert and wait for a human.
 *   public probe failing → re-apply the funnel once per backoff step, then it
 *                          is down to the operator.
 */

export type TailscaleBackend =
  | "unreachable" // CLI could not talk to the daemon/app at all
  | "Running"
  | "Stopped"
  | "NeedsLogin"
  | "NeedsMachineAuth"
  | "Starting"
  | "NoState"
  | string;

export interface TunnelObservation {
  backend: TailscaleBackend;
  /** Self.DNSName without the trailing dot, when known. */
  dnsName?: string;
  /** Funnel enabled on :443 with a handler proxying to the daemon. Undefined when not checked. */
  funnelOk?: boolean;
  /** Node key expiry (epoch ms). Undefined when expiry is disabled or unknown. */
  keyExpiry?: number;
  /** Result of fetching the public probe URL. Undefined when not attempted. */
  probe?: { ok: boolean; status?: number; error?: string };
}

export type TunnelProblem =
  | "app-down"
  | "stopped"
  | "needs-login"
  | "starting"
  | "funnel-missing"
  | "probe-failed";

export type TunnelRemedy = "launch-app" | "tailscale-up" | "apply-funnel";

export interface TunnelHealthConfig {
  /** Consecutive failing readings before acting — one blip is not an outage. */
  failuresBeforeAction: number;
  /** Delay before each successive remedy attempt within one outage. */
  backoffMs: number[];
  /** Re-send an unchanged alert at most this often. */
  realertMs: number;
  /** Warn this long before the node key expires (expiry logs the node out). */
  keyExpiryWarnMs: number;
  /** Repeat the expiry warning at most this often. */
  keyExpiryRewarnMs: number;
}

export const DEFAULT_TUNNEL_CONFIG: TunnelHealthConfig = {
  failuresBeforeAction: 2,
  // 0 → 5m → 15m → 1h, then hourly. Every remedy here is cheap and idempotent,
  // so the ladder exists to keep the log readable, not to protect anything.
  backoffMs: [0, 300_000, 900_000, 3_600_000],
  realertMs: 6 * 3_600_000,
  keyExpiryWarnMs: 14 * 86_400_000,
  keyExpiryRewarnMs: 3 * 86_400_000,
};

export interface TunnelState {
  consecutiveFailures: number;
  /** epoch ms of the first failing reading in the current outage. */
  failingSince?: number;
  /** Remedy attempts made in the current outage. */
  attempts: number;
  nextAttemptAt: number;
  /** What we last told the operator about, and when. Cleared on recovery. */
  alertedProblem?: TunnelProblem;
  alertedAt?: number;
  /** Last key-expiry warning. Survives recovery resets. */
  expiryWarnedAt?: number;
}

export function initialTunnelState(): TunnelState {
  return { consecutiveFailures: 0, attempts: 0, nextAttemptAt: 0 };
}

export interface TunnelDecision {
  state: TunnelState;
  problem?: TunnelProblem;
  remedy?: TunnelRemedy;
  /** Text for the operator. Present only when something is worth saying. */
  alert?: string;
  /** One-line summary for the log. */
  summary: string;
}

/** Reduce an observation to the single most upstream thing that is wrong. */
export function classifyTunnel(obs: TunnelObservation): TunnelProblem | undefined {
  switch (obs.backend) {
    case "unreachable":
      return "app-down";
    case "Stopped":
      return "stopped";
    case "NeedsLogin":
    case "NeedsMachineAuth":
      return "needs-login";
    case "Running":
      break;
    default:
      // Starting / NoState / anything new: transitional. Counted as failing so a
      // backend wedged in "Starting" still surfaces, but never remedied.
      return "starting";
  }
  if (obs.funnelOk === false) return "funnel-missing";
  if (obs.probe && !obs.probe.ok) return "probe-failed";
  return undefined;
}

const REMEDY: Record<TunnelProblem, TunnelRemedy | undefined> = {
  "app-down": "launch-app",
  stopped: "tailscale-up",
  "needs-login": undefined,
  starting: undefined,
  "funnel-missing": "apply-funnel",
  "probe-failed": "apply-funnel",
};

function describe(problem: TunnelProblem, obs: TunnelObservation): string {
  switch (problem) {
    case "app-down":
      return "Tailscale is not running (the CLI cannot reach it).";
    case "stopped":
      return "Tailscale is switched off (backend Stopped).";
    case "needs-login":
      return "Tailscale is logged out — it needs an interactive login on the Mac " +
        "(menu-bar icon → Log in). The daemon cannot fix this itself.";
    case "starting":
      return `Tailscale is stuck in state '${obs.backend}'.`;
    case "funnel-missing":
      return "Tailscale is up but the Funnel to the daemon's hook endpoint is not configured.";
    case "probe-failed": {
      const p = obs.probe;
      const why = p?.status ? `HTTP ${p.status}` : (p?.error ?? "no response");
      return `The Funnel is configured but the public hook URL is not answering (${why}).`;
    }
  }
}

function minutes(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m < 90 ? `${m} min` : `${(m / 60).toFixed(1)} h`;
}

/**
 * One supervision tick. Pure: never performs the remedy or sends the alert,
 * only says which to do. The caller must report the remedy's outcome back via
 * the next observation — there is no "remedy succeeded" input on purpose; the
 * only proof of a fix is a healthy reading.
 */
export function decideTunnel(
  now: number,
  obs: TunnelObservation,
  prev: TunnelState,
  config: TunnelHealthConfig = DEFAULT_TUNNEL_CONFIG,
): TunnelDecision {
  const problem = classifyTunnel(obs);
  const host = obs.dnsName ? ` (${obs.dnsName})` : "";

  if (!problem) {
    const wasAlerted = prev.alertedProblem !== undefined;
    const since = prev.failingSince;
    const state: TunnelState = initialTunnelState();
    if (prev.expiryWarnedAt !== undefined) state.expiryWarnedAt = prev.expiryWarnedAt;
    const parts: string[] = [];
    if (wasAlerted) {
      parts.push(`✅ Tailscale Funnel${host} is serving again` +
        (since ? ` after ${minutes(now - since)} down` : "") + ".");
    }
    // Key expiry logs the node out — the exact failure that killed the IronRod
    // pipeline for months. Warn ahead, since afterwards only a human can fix it.
    if (obs.keyExpiry !== undefined && obs.keyExpiry - now <= config.keyExpiryWarnMs &&
        (state.expiryWarnedAt === undefined || now - state.expiryWarnedAt >= config.keyExpiryRewarnMs)) {
      const days = Math.max(0, Math.floor((obs.keyExpiry - now) / 86_400_000));
      parts.push(`⏳ Tailscale node key${host} expires in ${days} day(s) (${new Date(obs.keyExpiry).toISOString().slice(0, 10)}). ` +
        "When it does, the node logs out and every external hook stops. Re-authenticate it, or disable key expiry " +
        "for this machine in the Tailscale admin console (Machines → ⋯ → Disable key expiry).");
      state.expiryWarnedAt = now;
    }
    return {
      state,
      summary: since ? `healthy again after ${minutes(now - since)}` : "healthy",
      ...(parts.length ? { alert: parts.join("\n") } : {}),
    };
  }

  const state: TunnelState = {
    ...prev,
    consecutiveFailures: prev.consecutiveFailures + 1,
    failingSince: prev.failingSince ?? now,
  };

  if (state.consecutiveFailures < config.failuresBeforeAction) {
    return { state, problem, summary: `${problem} (reading ${state.consecutiveFailures}, waiting to confirm)` };
  }

  // Remedy, if one exists and the backoff allows.
  let remedy: TunnelRemedy | undefined;
  const candidate = REMEDY[problem];
  if (candidate && now >= state.nextAttemptAt) {
    remedy = candidate;
    state.attempts += 1;
    const ladder = config.backoffMs;
    const nextDelay = ladder[Math.min(state.attempts, ladder.length - 1)] ?? 3_600_000;
    state.nextAttemptAt = now + nextDelay;
  }

  // Alert on the first confirmed failure, on a change of problem, and as a
  // reminder no more often than realertMs. Never on every tick.
  let alert: string | undefined;
  const changed = state.alertedProblem !== problem;
  const stale = state.alertedAt === undefined || now - state.alertedAt >= config.realertMs;
  if (changed || stale) {
    const down = state.failingSince ? minutes(now - state.failingSince) : "?";
    const action = remedy
      ? `Trying: ${remedy} (attempt ${state.attempts}).`
      : candidate
        ? `Next automatic retry in ${minutes(Math.max(0, state.nextAttemptAt - now))}.`
        : "No automatic fix — needs you.";
    alert =
      `⚠️ Tailscale Funnel${host} down ${down}: ${describe(problem, obs)} ${action}\n` +
      "External hooks (IronRod feedback, LetterGnome reviews) cannot reach the daemon until this clears.";
    state.alertedProblem = problem;
    state.alertedAt = now;
  }

  return {
    state,
    problem,
    ...(remedy ? { remedy } : {}),
    ...(alert ? { alert } : {}),
    summary: `${problem}${remedy ? ` → ${remedy}` : ""} (failing ${state.consecutiveFailures}x)`,
  };
}

// --- Parsing helpers for Tailscale CLI JSON (kept here so they are testable) ---

/** Pull BackendState and the node's DNS name out of `tailscale status --json`. */
export function parseStatusJson(stdout: string): { backend: string; dnsName?: string; keyExpiry?: number } {
  const j = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string; KeyExpiry?: string } };
  const dns = j.Self?.DNSName?.replace(/\.$/, "");
  const exp = j.Self?.KeyExpiry ? Date.parse(j.Self.KeyExpiry) : NaN;
  return {
    backend: j.BackendState ?? "NoState",
    ...(dns ? { dnsName: dns } : {}),
    ...(Number.isFinite(exp) ? { keyExpiry: exp } : {}),
  };
}

/**
 * True when `tailscale funnel status --json` shows Funnel enabled on
 * <dnsName>:443 and a handler that proxies to the daemon's port. When
 * `mountPath` is given, that exact handler must exist.
 */
export function funnelServesDaemon(
  stdout: string,
  dnsName: string,
  port: number,
  mountPath?: string,
): boolean {
  let j: {
    AllowFunnel?: Record<string, boolean>;
    Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>;
  };
  try {
    j = JSON.parse(stdout || "{}");
  } catch {
    return false;
  }
  const hp = `${dnsName}:443`;
  if (!j.AllowFunnel?.[hp]) return false;
  const handlers = j.Web?.[hp]?.Handlers ?? {};
  const target = new RegExp(`^https?://(127\\.0\\.0\\.1|localhost):${port}(/|$)`);
  return Object.entries(handlers).some(
    ([mount, h]) => (!mountPath || mount === mountPath) && !!h.Proxy && target.test(h.Proxy),
  );
}

// --- Sleep awareness -------------------------------------------------------
// A laptop in Power Nap wakes ("DarkWake") for a minute or two at a time with
// the network half-up. Probe failures then say nothing about the tunnel, and
// remedies/alerts just spam. These helpers decide when to stay quiet.

/** How long after a detected wake failures are ignored. */
export const WAKE_GRACE_MS = 3 * 60_000;
/** A DarkWake line older than this is assumed stale (a Sleep/Wake line would have followed). */
export const DARKWAKE_STALE_MS = 15 * 60_000;

/**
 * True when the wall-clock gap since the previous tick is far larger than the
 * tick interval — the process was suspended. Strictly more than 2x interval.
 */
export function detectSleepGap(lastTickAt: number | undefined, now: number, intervalMs: number): boolean {
  return lastTickAt !== undefined && now - lastTickAt > 2 * intervalMs;
}

export interface PowerEvent {
  kind: "sleep" | "darkwake" | "wake";
  /** epoch ms */
  at: number;
}

/** Latest Sleep / DarkWake / Wake event in `pmset -g log` output, if any. */
export function parsePmsetLog(stdout: string): PowerEvent | undefined {
  const re = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d) ([+-]\d\d)(\d\d) (Sleep|DarkWake|Wake)\s{2}/;
  let last: PowerEvent | undefined;
  for (const line of stdout.split("\n")) {
    const m = re.exec(line);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T${m[2]}${m[3]}:${m[4]}`);
    if (!Number.isFinite(at)) continue;
    last = { kind: m[5] === "Sleep" ? "sleep" : m[5] === "DarkWake" ? "darkwake" : "wake", at };
  }
  return last;
}

export interface WakeGraceState {
  /** Wall-clock of the previous tick. */
  lastTickAt?: number;
  /** Failures are ignored until this time. */
  graceUntil: number;
}

/**
 * Decide whether `now` is inside a post-wake grace window or a DarkWake.
 * Pure: takes the previous grace state, the optional pmset reading, returns
 * the new state plus whether to stay quiet and whether this tick opened a
 * fresh grace period (for the single log line).
 */
export function evaluateWakeGrace(
  now: number,
  prev: WakeGraceState,
  intervalMs: number,
  power?: PowerEvent,
  graceMs: number = WAKE_GRACE_MS,
): { state: WakeGraceState; quiet: boolean; reason?: "gap" | "darkwake" | "recent-wake"; fresh: boolean } {
  let graceUntil = prev.graceUntil;
  let reason: "gap" | "darkwake" | "recent-wake" | undefined;
  const wasQuiet = now < prev.graceUntil;
  if (detectSleepGap(prev.lastTickAt, now, intervalMs)) {
    graceUntil = Math.max(graceUntil, now + graceMs);
    reason = "gap";
  }
  if (power) {
    const age = now - power.at;
    if (power.kind === "darkwake" && age >= 0 && age < DARKWAKE_STALE_MS) {
      reason ??= "darkwake";
      graceUntil = Math.max(graceUntil, now + graceMs); // linger a full window after it ends
    } else if (power.kind === "wake" && age >= 0 && age < graceMs) {
      reason ??= "recent-wake";
      graceUntil = Math.max(graceUntil, power.at + graceMs);
    }
  }
  const quiet = now < graceUntil;
  return {
    state: { lastTickAt: now, graceUntil },
    quiet,
    ...(quiet ? { reason: reason ?? "gap" as const } : {}),
    fresh: quiet && !wasQuiet,
  };
}

/** Failing state discarded on entering grace, unless an alert is already out. */
export function discardUnconfirmedFailures(prev: TunnelState): TunnelState {
  if (prev.alertedProblem !== undefined) return prev;
  const s = initialTunnelState();
  if (prev.expiryWarnedAt !== undefined) s.expiryWarnedAt = prev.expiryWarnedAt;
  return s;
}
