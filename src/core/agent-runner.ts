import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";
import { getSession, saveSession, clearSession } from "./session-store.ts";
import { messagesTotal, queryDurationSeconds } from "./metrics.ts";
import { createSemaphore, type QueryPriority } from "./semaphore.ts";
import { createToolAwareActivityTimeout } from "./activity-timeout.ts";

export type { QueryPriority };
// Re-exported so existing imports (tests) keep working after the extraction.
export { createToolAwareActivityTimeout };

interface RunningQuery {
  query: Query;
  sessionId: string | null;
  agentKey: string;
  /**
   * Set when a subsequent message explicitly interrupts this query. Used by
   * the caller's catch block to distinguish a "replaced by new message" abort
   * (silent, expected) from a genuine failure or timeout.
   */
  interruptReason?: "new-message";
}

/**
 * Error thrown when a streaming run was aborted because a newer user message
 * interrupted it. Handlers should catch this specifically and stay silent —
 * the new message is already being processed.
 */
export class InterruptedByNextMessageError extends Error {
  constructor() {
    super("Interrupted by subsequent message");
    this.name = "InterruptedByNextMessageError";
  }
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

export function createAgentRunner(options: {
  maxConcurrent: number;
  mcpConfigPath: string;
  /**
   * SDK query factory — injectable so tests can drive runStreaming with
   * scripted message sequences instead of a real claude subprocess.
   */
  queryFn?: (args: { prompt: string; options: Options }) => Query;
  /**
   * Resolve the `--model` string for a run, based on the agent's current mode
   * (planning vs implementation) for the given chat/topic. Injected by the
   * server so the runner stays decoupled from config + mode storage. Omitted
   * (e.g. in tests) = fall back to the built-in default model.
   */
  resolveModel?: (agent: AgentConfig, topicId?: number) => Promise<string> | string;
}) {
  const { maxConcurrent, mcpConfigPath, resolveModel } = options;
  const DEFAULT_MODEL = "claude-opus-4-8";
  const queryFn = options.queryFn ?? query;
  const semaphore = createSemaphore(maxConcurrent);
  const agentMutex = new Map<string, Promise<void>>();
  const activeQueries = new Map<string, RunningQuery>();

  // Load MCP config once at startup. Each server entry may carry an optional
  // `restricted: true` flag indicating it's only available to agents that
  // opt-in via agents.json `mcpServers`. We strip that flag here before
  // handing configs to the SDK (which doesn't know the field) and remember
  // the restricted set so buildQueryOptions can filter per-agent.
  let mcpServers: Record<string, any> | undefined;
  const restrictedServers = new Set<string>();
  if (mcpConfigPath) {
    try {
      const raw = JSON.parse(
        require("fs").readFileSync(mcpConfigPath, "utf-8"),
      );
      if (raw.mcpServers) {
        mcpServers = {};
        for (const [name, config] of Object.entries(raw.mcpServers as Record<string, any>)) {
          const { restricted, ...sdkConfig } = config ?? {};
          if (restricted === true) restrictedServers.add(name);
          mcpServers[name] = sdkConfig;
        }
        log.info("runner", "Loaded MCP config", {
          servers: Object.keys(mcpServers),
          restricted: Array.from(restrictedServers),
        });
      }
    } catch {
      log.warn("runner", "Could not load MCP config", { path: mcpConfigPath });
    }
  }

  function getAgentKey(agentId: string, topicId?: number): string {
    return topicId ? `${agentId}-topic-${topicId}` : agentId;
  }

  function buildQueryOptions(agent: AgentConfig, resumeSessionId: string | null, model: string = DEFAULT_MODEL): Options {
    const opts: Options = {
      model,
      cwd: agent.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "user"],
      includePartialMessages: true,
      env: {
        ...process.env,
        // Enable persistent Tasks system (TaskCreate/TaskList/TaskGet/TaskUpdate).
        // Per-agent task list ID lets every claude -p invocation for this agent
        // share the same backlog across sessions and heartbeats.
        // Storage: ~/.claude/tasks/clawster-<agentId>/<taskId>.json
        CLAUDE_CODE_ENABLE_TASKS: "1",
        CLAUDE_CODE_TASK_LIST_ID: `clawster-${agent.id}`,
        // SDK 0.3.x changed MCP connections to non-blocking by default. Restore
        // pre-0.3 blocking behavior so Open Brain is ready before turn 1 — agents
        // call `ob search` / `ob capture` reflexively and a turn-1 miss is a regression.
        MCP_CONNECTION_NONBLOCKING: "0",
      },
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
          `Messages sent to you from another agent are prefixed with "[from: <agentId>] ".\n\n` +
          `You have a persistent task backlog scoped to you (list ID: clawster-${agent.id}).\n` +
          `Use TaskCreate / TaskList / TaskGet / TaskUpdate to track work that should\n` +
          `survive across sessions and heartbeats. Tasks support dependencies via the\n` +
          `'blocks' / 'blockedBy' fields, so you can queue follow-up work for your\n` +
          `future self. Don't use it for ephemeral in-conversation todos — TodoWrite\n` +
          `still covers that. Use Tasks for things that genuinely need to outlive this\n` +
          `session (open bugs you noticed, planned features, deferred refactors).`,
      },
    };

    if (resumeSessionId) {
      opts.resume = resumeSessionId;
      opts.forkSession = true;
    }

    if (mcpServers) {
      // Per-agent MCP ACL: include every non-restricted server unconditionally,
      // and only include restricted servers that this agent explicitly listed
      // in agents.json `mcpServers`. Empty/undefined agent allowlist = no
      // restricted servers granted. See types.ts AgentConfig.mcpServers for
      // the rationale (e.g. Playwright drives an authenticated browser and
      // shouldn't be available fleet-wide).
      const agentAllowlist = new Set(agent.mcpServers ?? []);
      const filtered: Record<string, any> = {};
      for (const [name, config] of Object.entries(mcpServers)) {
        if (restrictedServers.has(name) && !agentAllowlist.has(name)) continue;
        filtered[name] = config;
      }
      opts.mcpServers = filtered;
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

    // Tag the running query so its owning runStreaming loop can distinguish
    // "replaced by new user message" from a real failure or timeout when the
    // abort propagates through as a thrown error.
    running.interruptReason = "new-message";

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
   * Production wiring of the shared tool-aware timeout: on timeout, log and
   * abort the SDK query. The state machine itself lives in activity-timeout.ts
   * (one implementation, unit-tested directly).
   */
  function createActivityTimeout(
    agentId: string,
    abortController: AbortController,
    inactivityMs: number,
    maxMs: number,
  ) {
    return createToolAwareActivityTimeout({
      inactivityMs,
      maxMs,
      onTimeout: (reason, info) => {
        const elapsed = Math.round(info.elapsedMs / 1000);
        if (reason === "inactivity") {
          log.warn(agentId, `Query timed out after ${elapsed}s of inactivity`, {
            elapsed,
            toolsInFlight: info.toolsInFlight,
          });
        } else {
          log.warn(agentId, `Query hit max timeout of ${maxMs / 1000}s`, {
            elapsed,
            toolsInFlight: info.toolsInFlight,
          });
        }
        abortController.abort();
      },
    });
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
   * Non-streaming run — used by scheduler/heartbeats, media messages,
   * broadcasts, and inter-agent messages.
   *
   * Thin wrapper over runStreaming with a no-op update callback, so every
   * caller shares one battle-tested code path: stall retry, stale-session
   * self-heal, activeQueries registration (drain + interrupt visibility).
   * Historically this had its own duplicate loop that silently lacked all
   * three — heartbeat-driven agents could brick on an aged-out session.
   */
  async function run(
    agent: AgentConfig,
    prompt: string,
    runOptions?: { topicId?: number; timeout?: number; priority?: QueryPriority; sessionScope?: string },
  ): Promise<string> {
    const { text } = await runStreaming(agent, prompt, () => {}, runOptions);
    return text;
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
      /**
       * Extra session-key discriminator. Scheduled runs pass "scheduled" so
       * heartbeats keep their own conversation instead of forking — and then
       * overwriting — the user's session pointer.
       */
      sessionScope?: string;
      onActivity?: (status: ActivityStatus) => void;
      onEvent?: (event: ConversationEvent) => void;
      /**
       * What to do if the agent already has an in-flight query:
       *   - "queue" (default): chain on the per-agent mutex; process FIFO
       *     after the current turn finishes. Matches Claude Code's default.
       *   - "interrupt": abort the in-flight query and start fresh now.
       *     The prior caller's runStreaming will throw InterruptedByNextMessageError.
       */
      onBusy?: "interrupt" | "queue";
    },
  ): Promise<{ text: string; sessionId: string | null }> {
    if (isShuttingDown) {
      throw new Error("Runner is shutting down — not accepting new queries");
    }
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);
    const priority: QueryPriority = runOptions?.priority ?? "high";
    // High-priority (user-driven) queries get a longer inactivity window because
    // deep sessions (hundreds of messages) can plausibly sit silent during
    // cache-cold reasoning. Low-priority (heartbeat/scheduler) stays tighter.
    const defaultInactivitySec = priority === "high" ? 600 : 420;
    const inactivityTimeout = (agent.inactivityTimeout ?? defaultInactivitySec) * 1000;
    const maxTimeout = runOptions?.timeout ?? 1_800_000; // 30 min max
    const onBusy = runOptions?.onBusy ?? "queue";

    // Only interrupt the in-flight query when the caller explicitly asks.
    // Queue mode relies on the per-agent mutex below for FIFO serialization.
    const interruptedSessionId =
      onBusy === "interrupt" ? await interruptIfRunning(agentKey) : null;

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
      // Resolve the model once per run (mode is a per-chat setting that won't
      // change mid-turn), so a retry reuses the same model as the first attempt.
      const model = resolveModel
        ? await resolveModel(agent, runOptions?.topicId)
        : DEFAULT_MODEL;
      const MAX_ATTEMPTS = 2; // one initial + one retry on inactivity timeout
      try {
        // Retry loop: on mid-stream inactivity timeout, resume the saved session
        // and try once more. Handles upstream API stalls where Claude goes silent
        // for >inactivityTimeout mid-response. Other errors propagate normally.
        for (let attemptNo = 1; attemptNo <= MAX_ATTEMPTS; attemptNo++) {
        const isRetry = attemptNo > 1;
        const session = await getSession(agent.id, runOptions?.topicId, runOptions?.sessionScope);
        // First attempt: honor any interruptedSessionId. Retry: use whatever
        // session got saved during the previous attempt's timeout.
        const resumeSessionId = isRetry
          ? (session?.sessionId ?? null)
          : (interruptedSessionId ?? session?.sessionId ?? null);

        const opts = buildQueryOptions(agent, resumeSessionId, model);

        log.info(agent.id, "Starting SDK streaming query", {
          hasSession: !!resumeSessionId,
          interrupted: !!interruptedSessionId && !isRetry,
          retry: isRetry,
          attempt: attemptNo,
          model,
          inactivityTimeout,
          maxTimeout,
          priority,
        });

        const abortController = new AbortController();
        opts.abortController = abortController;

        const q = queryFn({ prompt, options: opts });
        const timer = createActivityTimeout(agent.id, abortController, inactivityTimeout, maxTimeout);

        const runningQuery: RunningQuery = {
          query: q,
          sessionId: resumeSessionId,
          agentKey,
        };
        activeQueries.set(agentKey, runningQuery);

        // Lifted out of the inner try so the catch block can see them and
        // save the partial session state before retrying on inactivity abort.
        let sessionId: string | null = resumeSessionId;
        let accumulated = "";

        try {
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
            log.error(agent.id, "SDK streaming query timed out", { elapsed: timer.elapsed, attempt: attemptNo });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId, runOptions?.sessionScope);
            }
            if (attemptNo < MAX_ATTEMPTS) {
              log.warn(agent.id, "Inactivity timeout — retrying with resumed session", {
                attempt: attemptNo,
                elapsed: timer.elapsed,
              });
              continue;
            }
            outcome = "timeout";
            return {
              text: `The agent was working for ${timer.elapsed}s across ${attemptNo} attempts but became unresponsive. Session is saved — send another message to resume.`,
              sessionId,
            };
          }

          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId, runOptions?.sessionScope);

          log.info(agent.id, "SDK streaming query completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
            elapsed: timer.elapsed,
          });

          return { text: finalText.trim(), sessionId };
        } catch (err) {
          timer.clear();
          // If this query was interrupted by a subsequent user message, throw
          // a specific error so the caller can stay silent (the replacement
          // handler is already running and will reply). Check the flag before
          // clearing the map entry.
          const wasInterruptedByNext = runningQuery.interruptReason === "new-message";
          activeQueries.delete(agentKey);
          if (wasInterruptedByNext) {
            outcome = "error";
            throw new InterruptedByNextMessageError();
          }
          // The inactivity timer aborts the SDK by calling abortController.abort(),
          // which causes the streaming `for await` above to throw rather than
          // exit cleanly. Without this branch the retry-on-stall logic at the
          // bottom of the success path is unreachable for the common case.
          // Mirror that behavior here: save the session and retry once.
          if (timer.timedOut) {
            log.error(agent.id, "SDK streaming query aborted by inactivity timeout (caught from SDK)", {
              elapsed: timer.elapsed,
              attempt: attemptNo,
            });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId, runOptions?.sessionScope);
            }
            if (attemptNo < MAX_ATTEMPTS) {
              log.warn(agent.id, "Inactivity timeout — retrying with resumed session", {
                attempt: attemptNo,
                elapsed: timer.elapsed,
              });
              continue;
            }
            outcome = "timeout";
            return {
              text: `The agent was working for ${timer.elapsed}s across ${attemptNo} attempts but became unresponsive. Session is saved — send another message to resume.`,
              sessionId,
            };
          }
          // Self-heal stale sessions: Claude Code ages saved conversations out
          // of its store, after which every resume of that ID fails identically
          // and the agent/topic is bricked until someone clears the file by hand.
          // Clear the dead pointer and retry once — the next pass reads a null
          // session and starts fresh, so the user gets a real reply on attempt 1.
          const errMsg = err instanceof Error ? err.message : String(err);
          if (
            /No conversation found with session ID/i.test(errMsg) &&
            resumeSessionId &&
            attemptNo < MAX_ATTEMPTS
          ) {
            log.warn(agent.id, "Stale session — clearing and retrying fresh", {
              staleSessionId: resumeSessionId.slice(0, 12),
              attempt: attemptNo,
            });
            await clearSession(agent.id, runOptions?.topicId, runOptions?.sessionScope);
            continue;
          }
          outcome = "error";
          throw err;
        }
        } // end retry for-loop — unreachable: success/timeout both return above
        throw new Error("runStreaming: retry loop exited without returning");
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
