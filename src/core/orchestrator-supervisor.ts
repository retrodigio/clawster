/**
 * The I/O half of orchestrator supervision.
 *
 * `supervisor.ts` holds the policy as a pure function. This module observes the
 * world, hands the observation to that policy, and performs whatever it decides.
 * Keeping the split means the interesting logic — when is a restart justified —
 * is testable without processes, and this file stays boring on purpose.
 *
 * The orchestrator runs as an interactive Claude Code session inside tmux.
 * It cannot be a background session: those silently drop channel events, and
 * the channels flag is not preserved across a supervisor respawn (both measured
 * against Claude Code 2.1.220).
 */

import { join } from "path";
import { homedir } from "os";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import {
  buildRecoveryManifest,
  decide,
  DEFAULT_SUPERVISOR_CONFIG,
  initialState,
  type PluginHealth,
  type SessionObservation,
  type SupervisorConfig,
  type SupervisorState,
} from "./supervisor.ts";
import { log } from "./logger.ts";

export interface OrchestratorSupervisorOptions {
  /** tmux session name holding the orchestrator. */
  tmuxSession: string;
  /** Working directory the orchestrator runs in (its CLAUDE.md lives here). */
  cwd: string;
  /** Channel plugin state dir, where dispatcher.health is published. */
  stateDir: string;
  /** MCP server name to load as a channel. */
  channelServer: string;
  /** Where recovery manifests are written. */
  recoveryDir: string;
  config?: SupervisorConfig;
  /** Injectable so tests and dry-runs don't spawn anything. */
  exec?: (cmd: string[]) => Promise<{ code: number; stdout: string }>;
  now?: () => number;
}

async function defaultExec(cmd: string[]): Promise<{ code: number; stdout: string }> {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const stdout = await new Response(p.stdout).text();
  const code = await p.exited;
  return { code, stdout };
}

export function defaultOptions(): OrchestratorSupervisorOptions {
  return {
    tmuxSession: "orchestrator",
    cwd: join(homedir(), "projects", "clawster-orchestrator"),
    stateDir: join(homedir(), ".claude", "channels", "telegram"),
    channelServer: "telegram-channel",
    recoveryDir: join(process.env.CLAWSTER_HOME ?? join(homedir(), ".clawster"), "recovery"),
  };
}

export class OrchestratorSupervisor {
  private state: SupervisorState = initialState();
  private readonly opts: Required<Pick<OrchestratorSupervisorOptions, "exec" | "now">> &
    OrchestratorSupervisorOptions;

  constructor(options?: Partial<OrchestratorSupervisorOptions>) {
    const merged = { ...defaultOptions(), ...options };
    this.opts = {
      ...merged,
      exec: merged.exec ?? defaultExec,
      now: merged.now ?? (() => Date.now()),
    };
  }

  getState(): SupervisorState {
    return this.state;
  }

  /** Clear a tripped breaker. Deliberately manual — see supervisor.ts. */
  resetCircuit(): void {
    this.state = initialState();
  }

  private healthPath(): string {
    return join(this.opts.stateDir, "dispatcher.health");
  }

  /**
   * Read the plugin's health file. Returns undefined when absent or unreadable —
   * which the policy treats as "no signal", never as evidence of a wedge.
   */
  readHealth(): PluginHealth | undefined {
    try {
      const p = this.healthPath();
      if (!existsSync(p)) return undefined;
      return JSON.parse(readFileSync(p, "utf8")) as PluginHealth;
    } catch {
      return undefined;
    }
  }

  /**
   * Observe the orchestrator.
   *
   * tmux is authoritative for "is it running" — the session either exists or it
   * does not. `claude agents --json` supplies the session UUID and busy/idle,
   * which we need for the recovery manifest but deliberately do NOT treat as
   * sufficient evidence of a wedge.
   */
  async observe(): Promise<SessionObservation> {
    const hasSession = await this.opts.exec([
      "tmux", "has-session", "-t", this.opts.tmuxSession,
    ]);
    if (hasSession.code !== 0) return { alive: false };

    let sessionId: string | undefined;
    let pid: number | undefined;
    let status: string | undefined;
    try {
      const r = await this.opts.exec(["claude", "agents", "--json"]);
      if (r.code === 0) {
        const rows = JSON.parse(r.stdout) as Array<Record<string, unknown>>;
        const match = rows.find(
          row => row.kind === "interactive" && String(row.cwd ?? "") === this.opts.cwd,
        );
        if (match) {
          sessionId = match.sessionId as string | undefined;
          pid = match.pid as number | undefined;
          status = match.status as string | undefined;
        }
      }
    } catch {
      // A missing or changed `claude agents --json` must not make us think the
      // orchestrator is dead — tmux already answered that question.
    }

    return { alive: true, sessionId, pid, status };
  }

  private projectHash(): string {
    // Claude Code's project dir name is the cwd with separators replaced.
    return this.opts.cwd.replace(/\//g, "-");
  }

  private liveThreadIds(): string[] {
    try {
      const p = join(this.opts.stateDir, "threads.json");
      if (!existsSync(p)) return [];
      return Object.keys(JSON.parse(readFileSync(p, "utf8")) as Record<string, unknown>);
    } catch {
      return [];
    }
  }

  /**
   * Write the recovery manifest BEFORE anything is killed.
   *
   * This is the point of the whole design: it turns the successor session's
   * "which session UUID held my orphaned subagents?" from an interactive guess
   * into a deterministic lookup.
   */
  writeRecoveryManifest(reason: string, session: SessionObservation): string | undefined {
    try {
      mkdirSync(this.opts.recoveryDir, { recursive: true });
      const now = this.opts.now();
      const manifest = buildRecoveryManifest({
        now,
        reason,
        session,
        projectHash: this.projectHash(),
        liveThreadIds: this.liveThreadIds(),
        home: homedir(),
      });
      const path = join(this.opts.recoveryDir, `${now}.json`);
      const tmp = `${path}.tmp`;
      writeFileSync(tmp, JSON.stringify(manifest, null, 2));
      renameSync(tmp, path);
      // Also snapshot threads.json, so a restart cannot corrupt it mid-write.
      const threads = join(this.opts.stateDir, "threads.json");
      if (existsSync(threads)) {
        writeFileSync(join(this.opts.recoveryDir, `${now}-threads.json`),
          readFileSync(threads, "utf8"));
      }
      log.warn("supervisor", "wrote recovery manifest", { path, reason });
      return path;
    } catch (e) {
      log.error("supervisor", "could not write recovery manifest", { error: String(e) });
      return undefined;
    }
  }

  /**
   * Start the orchestrator and PROVE it came up.
   *
   * Two traps, both learned the hard way:
   *
   * 1. Claude Code stops on interactive confirmations — the folder-trust prompt
   *    and the `--dangerously-load-development-channels` warning. Unattended,
   *    the session sits at that prompt forever. tmux reports a healthy session,
   *    the supervisor reports "started", and the orchestrator is silently deaf.
   *    So we send Enter a few times; an extra Enter at an idle Claude prompt is
   *    harmless.
   *
   * 2. `tmux new-session` exiting 0 only means tmux forked something. It says
   *    nothing about whether the channel plugin loaded. The authoritative proof
   *    is the plugin's own lock file, which it writes on startup — so we wait
   *    for that and return false if it never appears.
   */
  async startOrchestrator(timeoutMs = 45_000): Promise<boolean> {
    const cmd = [
      "tmux", "new-session", "-d", "-s", this.opts.tmuxSession,
      "-x", "220", "-y", "50", "-c", this.opts.cwd,
      `claude --dangerously-load-development-channels server:${this.opts.channelServer} --dangerously-skip-permissions`,
    ];
    const r = await this.opts.exec(cmd);
    if (r.code !== 0) {
      log.error("supervisor", "tmux could not start the orchestrator", { code: r.code });
      return false;
    }

    const lockFile = join(this.opts.stateDir, "plugin.lock");
    const deadline = Date.now() + timeoutMs;
    let enters = 0;

    while (Date.now() < deadline) {
      await new Promise(res => setTimeout(res, 3000));
      if (existsSync(lockFile)) {
        log.info("supervisor", "orchestrator up — channel plugin holding its lock", {
          session: this.opts.tmuxSession, confirmations: enters,
        });
        return true;
      }
      // Clear any confirmation prompt sitting in the way.
      if (enters < 6) {
        await this.opts.exec(["tmux", "send-keys", "-t", this.opts.tmuxSession, "Enter"]);
        enters++;
      }
    }

    log.error("supervisor", "orchestrator started but the channel plugin never came up — " +
      "it is probably stalled on a confirmation prompt. Attach and check.", {
      session: this.opts.tmuxSession, lockFile,
    });
    return false;
  }

  async stopOrchestrator(): Promise<void> {
    // SIGTERM-equivalent: tmux kill-session lets Claude Code flush transcripts,
    // which is what makes orphan recovery possible at all.
    await this.opts.exec(["tmux", "kill-session", "-t", this.opts.tmuxSession]);
  }

  /**
   * One supervision tick. Returns the action taken, for logging and tests.
   */
  async tick(): Promise<string> {
    const now = this.opts.now();
    const session = await this.observe();
    const health = this.readHealth();

    const { action, state } = decide({
      now, session, health, state: this.state, config: this.opts.config,
    });
    this.state = state;

    switch (action.kind) {
      case "none":
        return `none: ${action.reason}`;

      case "probe":
        // The probe itself is the orchestrator's job — we cannot inject a
        // channel event from here without a real chat. Logging it surfaces the
        // suspicion without paying the cost of a restart.
        log.warn("supervisor", "orchestrator looks wedged — probing", { reason: action.reason });
        return `probe: ${action.reason}`;

      case "start": {
        log.warn("supervisor", "orchestrator is down — starting", { reason: action.reason });
        const ok = await this.startOrchestrator();
        return `start(${ok ? "verified" : "FAILED"}): ${action.reason}`;
      }

      case "restart": {
        this.writeRecoveryManifest(action.reason, session);
        await this.stopOrchestrator();
        const ok = await this.startOrchestrator();
        return `restart(${ok ? "verified" : "FAILED"}): ${action.reason}`;
      }

      case "circuit-open":
        log.error("supervisor", "supervision circuit is open", { reason: action.reason });
        return `circuit-open: ${action.reason}`;
    }
  }
}

export { DEFAULT_SUPERVISOR_CONFIG };
