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

  return { run };
}
