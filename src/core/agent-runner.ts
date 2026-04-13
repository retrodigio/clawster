import { log } from "./logger.ts";
import type { AgentConfig } from "./types.ts";

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

// Track running processes per agent so we can interrupt them
interface RunningProcess {
  proc: ReturnType<typeof Bun.spawn>;
  sessionId: string | null;
  agentKey: string;
}

export function createAgentRunner(options: {
  maxConcurrent: number;
  mcpConfigPath: string;
  claudePath: string;
}) {
  const { maxConcurrent, mcpConfigPath, claudePath } = options;
  const semaphore = createSemaphore(maxConcurrent);
  const agentMutex = new Map<string, Promise<void>>();
  const activeProcesses = new Map<string, RunningProcess>();

  function getAgentKey(agentId: string, topicId?: number): string {
    return topicId ? `${agentId}-topic-${topicId}` : agentId;
  }

  /**
   * Interrupt a running process for an agent/topic.
   * Sends SIGINT, waits for exit, returns the session ID for resume.
   */
  async function interruptIfRunning(agentKey: string): Promise<string | null> {
    const running = activeProcesses.get(agentKey);
    if (!running) return null;

    log.info(running.agentKey, "Interrupting running process for new message", {
      sessionId: running.sessionId,
    });

    try {
      running.proc.kill("SIGINT");
      await running.proc.exited;
    } catch {
      // Process may have already exited
    }

    activeProcesses.delete(agentKey);
    return running.sessionId;
  }

  /**
   * Non-streaming run — used by scheduler/heartbeats.
   * Now properly extracts and saves session IDs via stream-json.
   */
  async function run(
    agent: AgentConfig,
    prompt: string,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<string> {
    const timeout = runOptions?.timeout ?? 300_000;
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
        const { getSession, saveSession } = await import("./session-store.ts");
        const session = await getSession(agent.id, runOptions?.topicId);

        const args: string[] = [
          claudePath, "-p", prompt,
          "--output-format", "stream-json",
          "--verbose",
        ];

        if (mcpConfigPath) {
          args.push("--mcp-config", mcpConfigPath);
        }

        if (session?.sessionId) {
          args.push("--resume", session.sessionId, "--fork-session");
        }

        log.info(agent.id, "Spawning claude process", {
          hasSession: !!session?.sessionId,
          timeout,
        });

        const proc = Bun.spawn(args, {
          cwd: agent.workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          log.warn(agent.id, "Process timed out, killing", { timeout });
          proc.kill();
        }, timeout);

        try {
          // Parse stream-json to extract session ID and result
          let sessionId: string | null = session?.sessionId ?? null;
          let resultText = "";

          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
                  sessionId = parsed.session_id;
                }
                if (parsed.type === "result") {
                  resultText = parsed.result ?? "";
                  if (parsed.session_id) sessionId = parsed.session_id;
                }
              } catch {
                // Skip unparseable lines
              }
            }
          }

          const stderrText = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;
          clearTimeout(timer);

          if (timedOut) {
            log.error(agent.id, "Claude process timed out", { timeout });
            // Still save session ID if we got one — allows resume after timeout
            if (sessionId && sessionId !== session?.sessionId) {
              await saveSession(agent.id, {
                sessionId,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }
            return "Sorry, the request timed out. Please try again with a simpler question.";
          }

          if (exitCode !== 0) {
            log.error(agent.id, "Claude process failed", {
              exitCode,
              stderr: stderrText.slice(0, 500),
            });

            if (
              stderrText.toLowerCase().includes("session") ||
              stderrText.toLowerCase().includes("resume")
            ) {
              log.warn(agent.id, "Session error detected, clearing session");
              await saveSession(agent.id, {
                sessionId: null,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }

            return "Something went wrong processing your message. Please try again.";
          }

          // Save session ID for future resume
          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "Claude process completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
          });

          return resultText.trim();
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
   * Supports interruption: if a new message arrives while this is running,
   * the bot can call interruptIfRunning() to SIGINT this process,
   * then resume with the new message using the captured session ID.
   */
  async function runStreaming(
    agent: AgentConfig,
    prompt: string,
    onUpdate: (textSoFar: string) => void,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<{ text: string; sessionId: string | null }> {
    const timeout = runOptions?.timeout ?? 300_000;
    const agentKey = getAgentKey(agent.id, runOptions?.topicId);

    // Interrupt any running process for this agent/topic
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
        const { getSession, saveSession } = await import("./session-store.ts");
        const session = await getSession(agent.id, runOptions?.topicId);

        // Use interrupted session ID if we just killed a running process,
        // otherwise use the persisted session ID
        const resumeSessionId = interruptedSessionId ?? session?.sessionId ?? null;

        const args: string[] = [
          claudePath, "-p", prompt,
          "--output-format", "stream-json",
          "--verbose",
          "--include-partial-messages",
        ];

        if (mcpConfigPath) {
          args.push("--mcp-config", mcpConfigPath);
        }

        if (resumeSessionId) {
          args.push("--resume", resumeSessionId, "--fork-session");
        }

        log.info(agent.id, "Spawning claude streaming process", {
          hasSession: !!resumeSessionId,
          interrupted: !!interruptedSessionId,
          timeout,
        });

        const proc = Bun.spawn(args, {
          cwd: agent.workspace,
          stdout: "pipe",
          stderr: "pipe",
          env: { ...process.env },
        });

        // Track this process so it can be interrupted
        const runningProcess: RunningProcess = {
          proc,
          sessionId: resumeSessionId,
          agentKey,
        };
        activeProcesses.set(agentKey, runningProcess);

        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          log.warn(agent.id, "Streaming process timed out, killing", { timeout });
          proc.kill();
        }, timeout);

        try {
          let accumulated = "";
          let sessionId: string | null = resumeSessionId;
          let resultText: string | null = null;
          let lastUpdateTime = 0;

          const reader = proc.stdout.getReader();
          const decoder = new TextDecoder();
          let buffer = "";

          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";

            for (const line of lines) {
              if (!line.trim()) continue;
              try {
                const parsed = JSON.parse(line);

                if (parsed.type === "system" && parsed.subtype === "init" && parsed.session_id) {
                  sessionId = parsed.session_id;
                  // Update the running process record with new session ID
                  runningProcess.sessionId = sessionId;
                }

                if (parsed.type === "stream_event") {
                  const evt = parsed.event;
                  if (evt?.delta?.type === "text_delta" && evt.delta.text) {
                    accumulated += evt.delta.text;
                    const now = Date.now();
                    if (now - lastUpdateTime >= 2000) {
                      lastUpdateTime = now;
                      onUpdate(accumulated);
                    }
                  }
                }

                if (parsed.type === "result") {
                  resultText = parsed.result ?? accumulated;
                  if (parsed.session_id) {
                    sessionId = parsed.session_id;
                  }
                }
              } catch {
                // Skip unparseable lines
              }
            }
          }

          // Remove from active processes
          activeProcesses.delete(agentKey);

          // Final update with complete text
          const finalText = resultText ?? accumulated;
          if (finalText) {
            onUpdate(finalText);
          }

          const stderrText = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;

          clearTimeout(timer);

          if (timedOut) {
            log.error(agent.id, "Claude streaming process timed out", { timeout });
            // Still save session for resume
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

          if (exitCode !== 0) {
            log.error(agent.id, "Claude streaming process failed", {
              exitCode,
              stderr: stderrText.slice(0, 500),
            });

            if (
              stderrText.toLowerCase().includes("session") ||
              stderrText.toLowerCase().includes("resume")
            ) {
              log.warn(agent.id, "Session error detected, clearing session");
              await saveSession(agent.id, {
                sessionId: null,
                lastActivity: new Date().toISOString(),
                lastHeartbeat: session?.lastHeartbeat ?? null,
                messageCount: session?.messageCount ?? 0,
              }, runOptions?.topicId);
            }

            return {
              text: "Something went wrong processing your message. Please try again.",
              sessionId,
            };
          }

          // Save session ID for future resume
          await saveSession(agent.id, {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          }, runOptions?.topicId);

          log.info(agent.id, "Claude streaming process completed", {
            sessionId: sessionId?.slice(0, 12),
            messageCount: (session?.messageCount ?? 0) + 1,
          });

          return { text: finalText.trim(), sessionId };
        } catch (err) {
          clearTimeout(timer);
          activeProcesses.delete(agentKey);
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
