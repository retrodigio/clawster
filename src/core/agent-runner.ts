import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";
import { getSession, saveSession } from "./session-store.ts";
import {
  messagesTotal,
  queryDurationSeconds,
  semaphoreQueueDepth,
  semaphoreInFlight,
} from "./metrics.ts";

export type QueryPriority = "high" | "low";

type QueuedResolve = () => void;

/**
 * Priority-aware semaphore.
 * - Two FIFO queues: "high" (user messages) and "low" (heartbeats/scheduled).
 * - When a slot opens, oldest "high" is dequeued first, then oldest "low".
 */
function createSemaphore(max: number) {
  let active = 0;
  const highQueue: QueuedResolve[] = [];
  const lowQueue: QueuedResolve[] = [];

  function updateDepthGauges(): void {
    semaphoreQueueDepth.set(highQueue.length, { priority: "high" });
    semaphoreQueueDepth.set(lowQueue.length, { priority: "low" });
    semaphoreInFlight.set(active);
  }

  function acquire(priority: QueryPriority): Promise<void> {
    if (active < max) {
      active++;
      updateDepthGauges();
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      if (priority === "high") {
        highQueue.push(resolve);
      } else {
        lowQueue.push(resolve);
      }
      updateDepthGauges();
    });
  }

  function release(): void {
    // Drain high before low.
    const next = highQueue.shift() ?? lowQueue.shift();
    if (next) {
      // Slot handed off — in-flight count stays the same.
      next();
    } else {
      active--;
    }
    updateDepthGauges();
  }

  // Initialise gauges at zero.
  updateDepthGauges();

  return { acquire, release };
}

interface RunningQuery {
  query: Query;
  sessionId: string | null;
  agentKey: string;
}

/** Activity status reported during tool use / thinking phases. */
export interface ActivityStatus {
  type: "tool_use" | "thinking" | "text";
  detail: string; // e.g. "Reading file", "Running command", "Writing code"
  elapsed: number; // seconds since query started
}

/** A single conversation event for CodeLayer-style streaming. */
export interface ConversationEvent {
  id: string;
  type: "system" | "user" | "assistant" | "tool_use" | "tool_result" | "text_delta" | "thinking" | "result";
  timestamp: string;
  data: any;
}

/**
 * Standalone activity-timeout factory exposed for unit testing.
 * Tool-aware: while toolsInFlight > 0, the effective inactivity ceiling is promoted to maxMs.
 *
 * See `createActivityTimeout` inside `createAgentRunner` for the production variant — this
 * mirrors the same logic without closing over agent/logger state (logs go through the
 * `onTimeout` callback for test assertions).
 */
export function createToolAwareActivityTimeout(options: {
  inactivityMs: number;
  maxMs: number;
  onTimeout: (reason: "inactivity" | "max", info: { elapsedMs: number; toolsInFlight: number }) => void;
  now?: () => number;
}) {
  const now = options.now ?? (() => Date.now());
  const { inactivityMs, maxMs, onTimeout } = options;
  const startTime = now();
  let timedOut = false;
  let inactivityTimer: ReturnType<typeof setTimeout>;
  let maxTimer: ReturnType<typeof setTimeout>;
  let toolsInFlight = 0;
  const openToolIds = new Set<string>();

  function resetInactivityTimer() {
    clearTimeout(inactivityTimer);
    const ms = toolsInFlight > 0 ? maxMs : inactivityMs;
    inactivityTimer = setTimeout(() => {
      if (timedOut) return;
      timedOut = true;
      onTimeout("inactivity", { elapsedMs: now() - startTime, toolsInFlight });
    }, ms);
  }

  resetInactivityTimer();

  maxTimer = setTimeout(() => {
    if (timedOut) return;
    timedOut = true;
    onTimeout("max", { elapsedMs: now() - startTime, toolsInFlight });
  }, maxMs);

  function trackMessage(message: any): number {
    let delta = 0;
    if (!message || typeof message !== "object") return delta;
    if (message.type === "assistant" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_use") {
            const id = typeof block.id === "string" ? block.id : null;
            if (id) {
              if (!openToolIds.has(id)) {
                openToolIds.add(id);
                toolsInFlight++;
                delta++;
              }
            } else {
              toolsInFlight++;
              delta++;
            }
          }
        }
      }
    }
    if (message.type === "user" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block && block.type === "tool_result") {
            const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
            if (id && openToolIds.has(id)) {
              openToolIds.delete(id);
              if (toolsInFlight > 0) {
                toolsInFlight--;
                delta--;
              }
            } else if (toolsInFlight > 0) {
              toolsInFlight--;
              delta--;
            }
          }
        }
      }
    }
    return delta;
  }

  return {
    observe(message: any) {
      trackMessage(message);
      resetInactivityTimer();
    },
    touch() {
      resetInactivityTimer();
    },
    get timedOut() {
      return timedOut;
    },
    get toolsInFlight() {
      return toolsInFlight;
    },
    clear() {
      clearTimeout(inactivityTimer);
      clearTimeout(maxTimer);
    },
  };
}

export function createAgentRunner(options: {
  maxConcurrent: number;
  mcpConfigPath: string;
}) {
  const { maxConcurrent, mcpConfigPath } = options;
  const semaphore = createSemaphore(maxConcurrent);
  const agentMutex = new Map<string, Promise<void>>();
  const activeQueries = new Map<string, RunningQuery>();

  // Load MCP config once at startup
  let mcpServers: Record<string, any> | undefined;
  if (mcpConfigPath) {
    try {
      const raw = JSON.parse(
        require("fs").readFileSync(mcpConfigPath, "utf-8"),
      );
      if (raw.mcpServers) {
        mcpServers = {};
        for (const [name, config] of Object.entries(raw.mcpServers as Record<string, any>)) {
          mcpServers[name] = config;
        }
        log.info("runner", "Loaded MCP config", { servers: Object.keys(mcpServers) });
      }
    } catch {
      log.warn("runner", "Could not load MCP config", { path: mcpConfigPath });
    }
  }

  function getAgentKey(agentId: string, topicId?: number): string {
    return topicId ? `${agentId}-topic-${topicId}` : agentId;
  }

  function buildQueryOptions(agent: AgentConfig, resumeSessionId: string | null): Options {
    const opts: Options = {
      model: "claude-opus-4-7",
      cwd: agent.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "user"],
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append:
          `You are ${agent.name}. Respond concisely — your output goes to Telegram.\n\n` +
          `You can message other agents running in this Clawster orchestrator:\n` +
          `  clawster msg <agentId> "message" --from=${agent.id}        # 1:1 send, fire-and-forget\n` +
          `  clawster msg <agentId> "message" --from=${agent.id} --wait # 1:1 send, wait for reply\n` +
          `  clawster msg --broadcast "message" --from=${agent.id}      # send to all agents (rate-limited: 1/30s)\n` +
          `Use 'clawster agent list' to see agent IDs. Use broadcast sparingly.\n` +
          `Messages sent to you from another agent are prefixed with "[from: <agentId>] ".`,
      },
    };

    if (resumeSessionId) {
      opts.resume = resumeSessionId;
      opts.forkSession = true;
    }

    if (mcpServers) {
      opts.mcpServers = mcpServers;
    }

    if (agent.extraArgs) {
      opts.extraArgs = agent.extraArgs;
    }

    return opts;
  }

  async function interruptIfRunning(agentKey: string): Promise<string | null> {
    const running = activeQueries.get(agentKey);
    if (!running) return null;

    log.info(running.agentKey, "Interrupting running query for new message", {
      sessionId: running.sessionId,
    });

    try {
      await running.query.interrupt();
    } catch {
      try {
        running.query.close();
      } catch {
        // Already closed
      }
    }

    activeQueries.delete(agentKey);
    return running.sessionId;
  }

  /**
   * Create an activity-based timeout that resets on any SDK activity.
   *
   * Tool-aware behavior:
   *   - While `toolsInFlight === 0`: inactivity fires after `inactivityMs` of silence.
   *   - While `toolsInFlight > 0`: the effective ceiling becomes `maxMs` (the hard max)
   *     because a long Bash / MCP / subagent Task call legitimately sits silent for minutes.
   *     We still reset on every tool_use/tool_result transition so finishing a tool re-checks.
   *   - `maxMs` is the absolute hard ceiling regardless of state.
   *
   * Matching SDK message shapes:
   *   - `assistant` message with `.message.content[]` containing `{ type: "tool_use", id }`
   *       → tool started, toolsInFlight++
   *   - `user` message with `.message.content[]` containing `{ type: "tool_result", tool_use_id }`
   *       → tool finished, toolsInFlight-- (never below zero)
   */
  function createActivityTimeout(
    agentId: string,
    abortController: AbortController,
    inactivityMs: number,
    maxMs: number,
  ) {
    const startTime = Date.now();
    let timedOut = false;
    let inactivityTimer: ReturnType<typeof setTimeout>;
    let maxTimer: ReturnType<typeof setTimeout>;
    let toolsInFlight = 0;
    const openToolIds = new Set<string>();

    function currentInactivityMs(): number {
      // While a tool is running, promote the inactivity ceiling up to maxMs so we
      // don't kill a legitimate long-running Bash/MCP/subagent call.
      return toolsInFlight > 0 ? maxMs : inactivityMs;
    }

    function resetInactivityTimer() {
      clearTimeout(inactivityTimer);
      const ms = currentInactivityMs();
      inactivityTimer = setTimeout(() => {
        timedOut = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log.warn(agentId, `Query timed out after ${elapsed}s of inactivity`, {
          inactivityMs: ms,
          elapsed,
          toolsInFlight,
        });
        abortController.abort();
      }, ms);
    }

    // Start inactivity timer
    resetInactivityTimer();

    // Hard ceiling
    maxTimer = setTimeout(() => {
      if (!timedOut) {
        timedOut = true;
        const elapsed = Math.round((Date.now() - startTime) / 1000);
        log.warn(agentId, `Query hit max timeout of ${maxMs / 1000}s`, {
          elapsed,
          toolsInFlight,
        });
        abortController.abort();
      }
    }, maxMs);

    /**
     * Inspect an SDK message and update toolsInFlight.
     * Returns the delta applied so callers/tests can observe transitions.
     */
    function trackMessage(message: any): number {
      let delta = 0;
      if (!message || typeof message !== "object") return delta;

      // assistant -> tool_use blocks start tools
      if (message.type === "assistant" && message.message?.content) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === "tool_use") {
              const id = typeof block.id === "string" ? block.id : null;
              if (id) {
                if (!openToolIds.has(id)) {
                  openToolIds.add(id);
                  toolsInFlight++;
                  delta++;
                }
              } else {
                // No id — still count it, best effort
                toolsInFlight++;
                delta++;
              }
            }
          }
        }
      }

      // user -> tool_result blocks end tools
      if (message.type === "user" && message.message?.content) {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block && block.type === "tool_result") {
              const id = typeof block.tool_use_id === "string" ? block.tool_use_id : null;
              if (id && openToolIds.has(id)) {
                openToolIds.delete(id);
                if (toolsInFlight > 0) {
                  toolsInFlight--;
                  delta--;
                }
              } else if (toolsInFlight > 0) {
                // Unknown id but we had something open — decrement best effort
                toolsInFlight--;
                delta--;
              }
            }
          }
        }
      }

      return delta;
    }

    return {
      /** Call on every SDK message to reset the inactivity timer. */
      touch() {
        resetInactivityTimer();
      },
      /** Inspect an SDK message, update tool-tracking state, and reset the timer. */
      observe(message: any) {
        trackMessage(message);
        resetInactivityTimer();
      },
      get timedOut() {
        return timedOut;
      },
      get elapsed() {
        return Math.round((Date.now() - startTime) / 1000);
      },
      get toolsInFlight() {
        return toolsInFlight;
      },
      clear() {
        clearTimeout(inactivityTimer);
        clearTimeout(maxTimer);
      },
    };
  }

  /**
   * Describe what the agent is doing based on SDK message type.
   */
  function describeActivity(message: any): string | null {
    if (message.type === "assistant" && message.message?.content) {
      const content = message.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === "tool_use") {
            const name = block.name ?? "tool";
            if (name.includes("Read") || name.includes("read")) return "Reading files...";
            if (name.includes("Write") || name.includes("write")) return "Writing files...";
            if (name.includes("Edit") || name.includes("edit")) return "Editing code...";
            if (name.includes("Bash") || name.includes("bash")) return "Running command...";
            if (name.includes("Grep") || name.includes("grep") || name.includes("Glob")) return "Searching codebase...";
            if (name.includes("Agent")) return "Delegating to sub-agent...";
            if (name.includes("WebFetch") || name.includes("WebSearch")) return "Searching the web...";
            return `Using ${name}...`;
          }
          if (block.type === "thinking") return "Thinking...";
        }
      }
    }
    if (message.type === "stream_event") {
      const evt = message.event as any;
      if (evt?.type === "content_block_start" && evt.content_block?.type === "tool_use") {
        const name = evt.content_block.name ?? "tool";
        if (name.includes("Read") || name.includes("read")) return "Reading files...";
        if (name.includes("Write") || name.includes("write")) return "Writing files...";
        if (name.includes("Edit") || name.includes("edit")) return "Editing code...";
        if (name.includes("Bash") || name.includes("bash")) return "Running command...";
        if (name.includes("Grep") || name.includes("grep") || name.includes("Glob")) return "Searching codebase...";
        if (name.includes("Agent")) return "Delegating to sub-agent...";
        return `Using ${name}...`;
      }
      if (evt?.type === "content_block_start" && evt.content_block?.type === "thinking") {
        return "Thinking...";
      }
    }
    return null;
  }

  /**
   * Non-streaming run — used by scheduler/heartbeats.
   * Uses activity-based timeout: 3min inactivity, 30min max.
   */
  async function run(
    agent: AgentConfig,
    prompt: string,
    runOptions?: { topicId?: number; timeout?: number; priority?: QueryPriority },
  ): Promise<string> {
    if (isShuttingDown) {
      throw new Error("Runner is shutting down — not accepting new queries");
    }
    const inactivityTimeout = (agent.inactivityTimeout ?? 180) * 1000; // Default 3 min inactivity
    const maxTimeout = runOptions?.timeout ?? 1_800_000; // 30 min max
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);
    const priority: QueryPriority = runOptions?.priority ?? "high";

    const prev = agentMutex.get(agentKey) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agentKey, prev.then(() => mutexPromise));

    await prev;

    try {
      await semaphore.acquire(priority);

      const queryStart = Date.now();
      let outcome: "success" | "error" | "timeout" = "success";
      try {
        const session = await getSession(agent.id, runOptions?.topicId);
        const resumeSessionId = session?.sessionId ?? null;

        const opts = buildQueryOptions(agent, resumeSessionId);

        log.info(agent.id, "Starting SDK query", {
          hasSession: !!resumeSessionId,
          inactivityTimeout,
          maxTimeout,
          priority,
        });

        const abortController = new AbortController();
        opts.abortController = abortController;

        const q = query({ prompt, options: opts });
        const timer = createActivityTimeout(agent.id, abortController, inactivityTimeout, maxTimeout);

        let sessionId: string | null = null;
        let resultText = "";

        try {
          for await (const message of q) {
            timer.observe(message); // Reset inactivity + update tool-in-flight tracking

            if (message.type === "system" && message.subtype === "init") {
              sessionId = message.session_id;
            }

            if (message.type === "result") {
              if ("result" in message) {
                resultText = message.result ?? "";
              }
              if (message.session_id) {
                sessionId = message.session_id;
              }
            }
          }

          timer.clear();

          if (timer.timedOut) {
            log.error(agent.id, "SDK query timed out", { elapsed: timer.elapsed });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }
            outcome = "timeout";
            return "Sorry, the request timed out. Please try again with a simpler question.";
          }

          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "SDK query completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
            elapsed: timer.elapsed,
          });

          return resultText.trim();
        } catch (err) {
          timer.clear();
          outcome = "error";
          throw err;
        }
      } catch (err) {
        if (outcome === "success") outcome = "error";
        throw err;
      } finally {
        const elapsedSeconds = (Date.now() - queryStart) / 1000;
        queryDurationSeconds.observe(elapsedSeconds, { agent: agent.id, priority });
        messagesTotal.inc({ agent: agent.id, priority, outcome });
        semaphore.release();
      }
    } finally {
      releaseMutex!();
    }
  }

  /**
   * Streaming run — used by text message handler.
   * Activity-based timeout: 3min inactivity, 30min max.
   * Reports activity status via onActivity callback.
   */
  async function runStreaming(
    agent: AgentConfig,
    prompt: string,
    onUpdate: (textSoFar: string) => void,
    runOptions?: {
      topicId?: number;
      timeout?: number;
      priority?: QueryPriority;
      onActivity?: (status: ActivityStatus) => void;
      onEvent?: (event: ConversationEvent) => void;
    },
  ): Promise<{ text: string; sessionId: string | null }> {
    if (isShuttingDown) {
      throw new Error("Runner is shutting down — not accepting new queries");
    }
    const inactivityTimeout = (agent.inactivityTimeout ?? 180) * 1000; // Default 3 min inactivity
    const maxTimeout = runOptions?.timeout ?? 1_800_000; // 30 min max
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);
    const priority: QueryPriority = runOptions?.priority ?? "high";

    const interruptedSessionId = await interruptIfRunning(agentKey);

    const prev = agentMutex.get(agentKey) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agentKey, prev.then(() => mutexPromise));

    await prev;

    try {
      await semaphore.acquire(priority);

      const queryStart = Date.now();
      let outcome: "success" | "error" | "timeout" = "success";
      try {
        const session = await getSession(agent.id, runOptions?.topicId);
        const resumeSessionId = interruptedSessionId ?? session?.sessionId ?? null;

        const opts = buildQueryOptions(agent, resumeSessionId);

        log.info(agent.id, "Starting SDK streaming query", {
          hasSession: !!resumeSessionId,
          interrupted: !!interruptedSessionId,
          inactivityTimeout,
          maxTimeout,
          priority,
        });

        const abortController = new AbortController();
        opts.abortController = abortController;

        const q = query({ prompt, options: opts });
        const timer = createActivityTimeout(agent.id, abortController, inactivityTimeout, maxTimeout);

        const runningQuery: RunningQuery = {
          query: q,
          sessionId: resumeSessionId,
          agentKey,
        };
        activeQueries.set(agentKey, runningQuery);

        try {
          let accumulated = "";
          let sessionId: string | null = resumeSessionId;
          let resultText: string | null = null;
          let lastUpdateTime = 0;
          let lastActivityTime = 0;
          const startTime = Date.now();

          // Helper to emit conversation events when onEvent is provided
          const emitEvent = runOptions?.onEvent
            ? (type: ConversationEvent["type"], data: any) => {
                runOptions.onEvent!({
                  id: crypto.randomUUID(),
                  type,
                  timestamp: new Date().toISOString(),
                  data,
                });
              }
            : null;

          for await (const message of q) {
            timer.observe(message); // Reset inactivity + update tool-in-flight tracking

            if (message.type === "system" && message.subtype === "init") {
              sessionId = message.session_id;
              runningQuery.sessionId = sessionId;
              emitEvent?.("system", { subtype: (message as any).subtype, session_id: message.session_id });
            } else if (message.type === "system") {
              emitEvent?.("system", { subtype: (message as any).subtype, session_id: (message as any).session_id });
            }

            // Emit events for assistant messages (tool_use blocks, thinking blocks)
            if (emitEvent && message.type === "assistant" && (message as any).message?.content) {
              const content = (message as any).message.content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type === "tool_use") {
                    emitEvent("tool_use", { tool_use_id: block.id, name: block.name, input: block.input });
                  } else if (block.type === "thinking") {
                    emitEvent("thinking", { text: block.text ?? block.thinking });
                  }
                }
              }
            }

            // Emit events for tool results
            if (emitEvent && message.type === "result" && (message as any).tool_results) {
              // Handle tool results if present on result messages
            }
            // Tool result messages from SDK
            if (emitEvent && (message as any).type === "tool_result") {
              const msg = message as any;
              emitEvent("tool_result", { tool_use_id: msg.tool_use_id, content: msg.content });
            }

            // Stream text deltas for live Telegram updates
            if (message.type === "stream_event") {
              const evt = message.event as any;
              if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
                accumulated += evt.delta.text;
                const now = Date.now();
                if (now - lastUpdateTime >= 2000) {
                  lastUpdateTime = now;
                  await onUpdate(accumulated);
                }
                emitEvent?.("text_delta", { text: evt.delta.text, accumulated });
              }

              // Emit stream-level events for tool_use and thinking starts
              if (emitEvent) {
                if (evt?.type === "content_block_start" && evt.content_block?.type === "tool_use") {
                  emitEvent("tool_use", { name: evt.content_block.name, tool_use_id: evt.content_block.id });
                } else if (evt?.type === "content_block_start" && evt.content_block?.type === "thinking") {
                  emitEvent("thinking", {});
                }
              }
            }

            // Report activity status (tool use, thinking) for status updates
            if (runOptions?.onActivity) {
              const description = describeActivity(message);
              if (description) {
                const now = Date.now();
                // Throttle activity updates to every 10 seconds
                if (now - lastActivityTime >= 10_000) {
                  lastActivityTime = now;
                  const elapsed = Math.round((now - startTime) / 1000);
                  await runOptions.onActivity({
                    type: description.includes("Thinking") ? "thinking" : "tool_use",
                    detail: description,
                    elapsed,
                  });
                }
              }
            }

            if (message.type === "result") {
              if ("result" in message) {
                resultText = message.result ?? accumulated;
              }
              if (message.session_id) {
                sessionId = message.session_id;
              }
              emitEvent?.("result", { text: resultText ?? accumulated, session_id: sessionId });
            }
          }

          activeQueries.delete(agentKey);

          const finalText = resultText ?? accumulated;

          timer.clear();

          if (timer.timedOut) {
            log.error(agent.id, "SDK streaming query timed out", { elapsed: timer.elapsed });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }
            outcome = "timeout";
            return {
              text: `The agent was working for ${timer.elapsed}s but became unresponsive. Session is saved — send another message to resume.`,
              sessionId,
            };
          }

          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "SDK streaming query completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
            elapsed: timer.elapsed,
          });

          return { text: finalText.trim(), sessionId };
        } catch (err) {
          timer.clear();
          activeQueries.delete(agentKey);
          outcome = "error";
          throw err;
        }
      } catch (err) {
        if (outcome === "success") outcome = "error";
        throw err;
      } finally {
        const elapsedSeconds = (Date.now() - queryStart) / 1000;
        queryDurationSeconds.observe(elapsedSeconds, { agent: agent.id, priority });
        messagesTotal.inc({ agent: agent.id, priority, outcome });
        semaphore.release();
      }
    } finally {
      releaseMutex!();
    }
  }

  // --- Graceful shutdown support ---
  let isShuttingDown = false;

  /** Signal that no new queries should be accepted. */
  function shutdown(): void {
    isShuttingDown = true;
    log.info("runner", "Shutdown signaled — rejecting new queries");
  }

  /**
   * Wait for all in-flight queries to complete, or reject after timeoutMs.
   * Resolves when activeQueries is empty.
   */
  function drain(timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      // Check immediately
      if (activeQueries.size === 0) {
        log.info("runner", "No active queries — drain complete");
        resolve();
        return;
      }

      log.info("runner", "Draining active queries", { count: activeQueries.size });

      const timer = setTimeout(() => {
        clearInterval(poller);
        const remaining = activeQueries.size;
        if (remaining > 0) {
          log.warn("runner", `Drain timeout — ${remaining} queries still active, aborting them`);
          // Abort remaining queries
          for (const [key, rq] of activeQueries) {
            try {
              rq.query.close();
            } catch {
              // Already closed
            }
            activeQueries.delete(key);
          }
        }
        resolve(); // Resolve even on timeout — we did our best
      }, timeoutMs);

      const poller = setInterval(() => {
        if (activeQueries.size === 0) {
          clearTimeout(timer);
          clearInterval(poller);
          log.info("runner", "All active queries drained");
          resolve();
        }
      }, 500);
    });
  }

  /** Check if the runner is accepting new queries. */
  function isAccepting(): boolean {
    return !isShuttingDown;
  }

  return { run, runStreaming, shutdown, drain, isAccepting };
}
