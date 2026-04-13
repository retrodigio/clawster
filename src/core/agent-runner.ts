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

export function createAgentRunner(options: {
  maxConcurrent: number;
  mcpConfigPath: string;
  claudePath: string;
}) {
  const { maxConcurrent, mcpConfigPath, claudePath } = options;
  const semaphore = createSemaphore(maxConcurrent);
  const agentMutex = new Map<string, Promise<void>>();

  async function run(
    agent: AgentConfig,
    prompt: string,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<string> {
    const timeout = runOptions?.timeout ?? 300_000;

    // Per-agent mutex: chain promises so only one claude process per agent
    const prev = agentMutex.get(agent.id) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agent.id, prev.then(() => mutexPromise));

    await prev;

    try {
      await semaphore.acquire();

      try {
        const { getSession, saveSession } = await import("./session-store.ts");

        const session = await getSession(agent.id, runOptions?.topicId);

        const args: string[] = [claudePath, "-p", prompt, "--output-format", "text"];

        if (mcpConfigPath) {
          args.push("--mcp-config", mcpConfigPath);
        }

        if (session?.sessionId) {
          args.push("--resume", session.sessionId);
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
          const stdoutText = await new Response(proc.stdout).text();
          const stderrText = await new Response(proc.stderr).text();
          const exitCode = await proc.exited;

          clearTimeout(timer);

          if (timedOut) {
            log.error(agent.id, "Claude process timed out", { timeout });
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

          // Parse session ID from stdout — claude outputs it on resume-capable runs
          // Update session on success
          const updatedSession = {
            sessionId: session?.sessionId ?? null,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          };
          await saveSession(agent.id, updatedSession, runOptions?.topicId);

          log.info(agent.id, "Claude process completed", {
            messageCount: updatedSession.messageCount,
          });

          return stdoutText.trim();
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

  async function runStreaming(
    agent: AgentConfig,
    prompt: string,
    onUpdate: (textSoFar: string) => void,
    runOptions?: { topicId?: number; timeout?: number },
  ): Promise<{ text: string; sessionId: string | null }> {
    const timeout = runOptions?.timeout ?? 300_000;

    // Per-agent mutex: chain promises so only one claude process per agent
    const prev = agentMutex.get(agent.id) ?? Promise.resolve();
    let releaseMutex: () => void;
    const mutexPromise = new Promise<void>((resolve) => {
      releaseMutex = resolve;
    });
    agentMutex.set(agent.id, prev.then(() => mutexPromise));

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
          "--include-partial-messages",
        ];

        if (mcpConfigPath) {
          args.push("--mcp-config", mcpConfigPath);
        }

        if (session?.sessionId) {
          args.push("--resume", session.sessionId);
        }

        log.info(agent.id, "Spawning claude streaming process", {
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
          log.warn(agent.id, "Streaming process timed out, killing", { timeout });
          proc.kill();
        }, timeout);

        try {
          let accumulated = "";
          let sessionId: string | null = session?.sessionId ?? null;
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

          const updatedSession = {
            sessionId,
            lastActivity: new Date().toISOString(),
            lastHeartbeat: session?.lastHeartbeat ?? null,
            messageCount: (session?.messageCount ?? 0) + 1,
          };
          await saveSession(agent.id, updatedSession, runOptions?.topicId);

          log.info(agent.id, "Claude streaming process completed", {
            messageCount: updatedSession.messageCount,
          });

          return { text: finalText.trim(), sessionId };
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

  return { run, runStreaming };
}
