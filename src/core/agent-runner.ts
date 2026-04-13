import { query, type Query, type Options } from "@anthropic-ai/claude-agent-sdk";
import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";
import { getSession, saveSession } from "./session-store.ts";

type QueuedResolve = () => void;

function createSemaphore(max: number) {
  let active = 0;
  const queue: QueuedResolve[] = [];

  function acquire(): Promise<void> {
    if (active < max) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      queue.push(resolve);
    });
  }

  function release(): void {
    if (queue.length > 0) {
      const next = queue.shift()!;
      next();
    } else {
      active--;
    }
  }

  return { acquire, release };
}

interface RunningQuery {
  query: Query;
  sessionId: string | null;
  agentKey: string;
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
          // Pass through — config should use SDK-compatible types (sse, http, stdio)
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

  /** Build SDK options common to all runs for a given agent. */
  function buildQueryOptions(agent: AgentConfig, resumeSessionId: string | null): Options {
    const opts: Options = {
      cwd: agent.workspace,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      settingSources: ["project", "user"],
      includePartialMessages: true,
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: `You are ${agent.name}. Respond concisely — your output goes to Telegram.`,
      },
    };

    if (resumeSessionId) {
      opts.resume = resumeSessionId;
      opts.forkSession = true;
    }

    if (mcpServers) {
      opts.mcpServers = mcpServers;
    }

    return opts;
  }

  /**
   * Interrupt a running query for an agent/topic.
   * Uses SDK's interrupt() for graceful stop, returns session ID for resume.
   */
  async function interruptIfRunning(agentKey: string): Promise<string | null> {
    const running = activeQueries.get(agentKey);
    if (!running) return null;

    log.info(running.agentKey, "Interrupting running query for new message", {
      sessionId: running.sessionId,
    });

    try {
      await running.query.interrupt();
    } catch {
      // Query may have already completed
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
   * Extract text result from SDK messages (non-streaming).
   * Collects all messages and returns the final result text.
   */
  async function collectResult(
    q: Query,
    agentKey: string,
    onSessionId?: (id: string) => void,
  ): Promise<{ text: string; sessionId: string | null }> {
    let sessionId: string | null = null;
    let resultText = "";

    for await (const message of q) {
      if (message.type === "system" && message.subtype === "init") {
        sessionId = message.session_id;
        onSessionId?.(sessionId);
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

    return { text: resultText.trim(), sessionId };
  }

  /**
   * Non-streaming run — used by scheduler/heartbeats.
   */
  async function run(
    agent: AgentConfig,
    prompt: string,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<string> {
    const timeout = runOptions?.timeout ?? 600_000;
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);

    const prev = agentMutex.get(agentKey) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agentKey, prev.then(() => mutexPromise));

    await prev;

    try {
      await semaphore.acquire();

      try {
        const session = await getSession(agent.id, runOptions?.topicId);
        const resumeSessionId = session?.sessionId ?? null;

        const opts = buildQueryOptions(agent, resumeSessionId);

        log.info(agent.id, "Starting SDK query", {
          hasSession: !!resumeSessionId,
          timeout,
        });

        const abortController = new AbortController();
        opts.abortController = abortController;

        const q = query({ prompt, options: opts });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          log.warn(agent.id, "Query timed out, aborting", { timeout });
          abortController.abort();
        }, timeout);

        try {
          const { text, sessionId } = await collectResult(q, agentKey);

          clearTimeout(timer);

          if (timedOut) {
            log.error(agent.id, "SDK query timed out", { timeout });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }
            return "Sorry, the request timed out. Please try again with a simpler question.";
          }

          // Save session for future resume
          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "SDK query completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
          });

          return text;
        } catch (err) {
          clearTimeout(timer);
          throw err;
        }
      } finally {
        semaphore.release();
      }
    } finally {
      releaseMutex!();
    }
  }

  /**
   * Streaming run — used by text message handler.
   * Supports interruption via SDK's interrupt() method.
   */
  async function runStreaming(
    agent: AgentConfig,
    prompt: string,
    onUpdate: (textSoFar: string) => void,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<{ text: string; sessionId: string | null }> {
    const timeout = runOptions?.timeout ?? 600_000;
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);

    // Interrupt any running query for this agent/topic
    const interruptedSessionId = await interruptIfRunning(agentKey);

    const prev = agentMutex.get(agentKey) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agentKey, prev.then(() => mutexPromise));

    await prev;

    try {
      await semaphore.acquire();

      try {
        const session = await getSession(agent.id, runOptions?.topicId);

        // Use interrupted session ID if we just stopped a running query,
        // otherwise use the persisted session ID
        const resumeSessionId = interruptedSessionId ?? session?.sessionId ?? null;

        const opts = buildQueryOptions(agent, resumeSessionId);

        log.info(agent.id, "Starting SDK streaming query", {
          hasSession: !!resumeSessionId,
          interrupted: !!interruptedSessionId,
          timeout,
        });

        const abortController = new AbortController();
        opts.abortController = abortController;

        const q = query({ prompt, options: opts });

        // Track this query so it can be interrupted
        const runningQuery: RunningQuery = {
          query: q,
          sessionId: resumeSessionId,
          agentKey,
        };
        activeQueries.set(agentKey, runningQuery);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          log.warn(agent.id, "Streaming query timed out, aborting", { timeout });
          abortController.abort();
        }, timeout);

        try {
          let accumulated = "";
          let sessionId: string | null = resumeSessionId;
          let resultText: string | null = null;
          let lastUpdateTime = 0;

          for await (const message of q) {
            if (message.type === "system" && message.subtype === "init") {
              sessionId = message.session_id;
              runningQuery.sessionId = sessionId;
            }

            // Stream text deltas for live Telegram updates
            if (message.type === "stream_event") {
              const evt = message.event as any;
              if (evt?.type === "content_block_delta" && evt.delta?.type === "text_delta" && evt.delta.text) {
                accumulated += evt.delta.text;
                const now = Date.now();
                if (now - lastUpdateTime >= 2000) {
                  lastUpdateTime = now;
                  onUpdate(accumulated);
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
            }
          }

          // Remove from active queries
          activeQueries.delete(agentKey);

          const finalText = resultText ?? accumulated;

          clearTimeout(timer);

          if (timedOut) {
            log.error(agent.id, "SDK streaming query timed out", { timeout });
            if (sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }
            return {
              text: "Sorry, the request timed out. Please try again with a simpler question.",
              sessionId,
            };
          }

          // Save session for future resume
          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "SDK streaming query completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
          });

          return { text: finalText.trim(), sessionId };
        } catch (err) {
          clearTimeout(timer);
          activeQueries.delete(agentKey);
          throw err;
        }
      } finally {
        semaphore.release();
      }
    } finally {
      releaseMutex!();
    }
  }

  return { run, runStreaming };
}
