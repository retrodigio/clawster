import { join } from "path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { loadApiToken } from "./config.ts";
import { initConfigStore, getConfig, reloadConfigStore, onConfigChange } from "./config-store.ts";
import { initRouter, resolveAgent } from "./router.ts";
import { createAgentRunner } from "./agent-runner.ts";
import { createBot } from "./bot.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { log } from "./logger.ts";
import { startWebApi } from "./web-api.ts";
import { startScheduler } from "./scheduler.ts";
import { walPending, walDone } from "./message-wal.ts";
import { resolveAgentModel } from "./model-resolver.ts";
import { OrchestratorSupervisor } from "./orchestrator-supervisor.ts";

export async function startServer() {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    log.error("orchestrator", "Failed to acquire lock — another instance may be running");
    process.exit(1);
  }

  const { config, agents, chatIdToAgent, agentById, defaultAgent } = await initConfigStore();
  const apiToken = await loadApiToken();

  const unboundChatIds = new Set<string>(agents.unboundChatIds);
  initRouter(chatIdToAgent, defaultAgent, unboundChatIds, agents);

  // Keep the router in sync with config changes (web API edits, discovery,
  // topic registration). Without this, routing and heartbeats ran on the
  // startup snapshot until the next restart.
  onConfigChange((cfg) => {
    initRouter(
      cfg.chatIdToAgent,
      cfg.defaultAgent,
      new Set(cfg.agents.unboundChatIds),
      cfg.agents,
    );
    log.info("orchestrator", "Config reloaded — router re-initialized", {
      agents: cfg.agentById.size,
    });
  });

  const resolveAgentFn = (chatId: string, isPrivate: boolean) =>
    resolveAgent(chatId, isPrivate);

  // MCP config — global server registry. Entries marked `restricted: true`
  // are only granted to agents that opt-in via agents.json `mcpServers`; all
  // other entries (e.g. Open Brain) are available to every agent.
  const mcpConfigPath = join(import.meta.dir, "..", "..", "config", "mcp-servers.json");

  const runner = createAgentRunner({
    maxConcurrent: config.maxConcurrent,
    mcpConfigPath,
    resolveModel: resolveAgentModel,
  });

  const orchestratorMode = config.mode === "orchestrator";

  const maskedToken = config.botToken.slice(0, 6) + "..." + config.botToken.slice(-4);
  log.info("orchestrator", "Starting orchestrator", {
    agents: agentById.size,
    botToken: maskedToken,
    allowedUserId: config.allowedUserId,
    mode: config.mode,
  });

  // In orchestrator mode the daemon must NOT poll Telegram — a live Claude Code
  // session owns the bot connection through the telegram-channel plugin, and
  // Telegram permits exactly one getUpdates consumer per token. Two pollers give
  // 409s and unpredictable delivery.
  //
  // Sending is unaffected: the scheduler posts heartbeats over plain HTTP
  // sendMessage, which conflicts with nobody's polling. Heartbeats keep working
  // in both modes.
  const bot = orchestratorMode
    ? undefined
    : createBot({
        botToken: config.botToken,
        allowedUserId: config.allowedUserId,
        groqKey: config.groqKey,
        resolveAgent: resolveAgentFn,
        runner,
        agentById,
      });

  // Use @grammyjs/runner instead of bot.start() — the default sequentializes
  // update handlers, which means a slow Claude subprocess for one agent blocks
  // updates destined for every OTHER agent's chat. The runner dispatches each
  // update concurrently so a long-running reply in chat A can't starve chat B.
  // Concurrency of actual `claude -p` subprocesses remains bounded by the
  // runner's internal priority-aware semaphore (maxConcurrent).
  let botHandle: RunnerHandle | undefined;
  if (bot) {
    await bot.init();
    log.info("orchestrator", "Bot is running!");
    botHandle = run(bot);
  } else {
    log.info("orchestrator", "Orchestrator mode — not polling Telegram; " +
      "a supervised Claude Code session owns the bot connection");
  }

  // Report messages orphaned by a mid-processing restart (WAL entries that
  // never got their reply). Without this, a crash between Telegram's ack and
  // our reply loses the message with zero trace.
  (async () => {
    if (!bot) return; // no bot to notify through in orchestrator mode
    const orphans = await walPending();
    for (const orphan of orphans) {
      try {
        await bot.api.sendMessage(
          orphan.chatId,
          `⚠️ I restarted while working on this message and may not have answered it:\n\n"${orphan.text.slice(0, 300)}"\n\nResend it if you still need a reply.`,
          orphan.topicId ? { message_thread_id: orphan.topicId } : undefined,
        );
      } catch (err) {
        log.warn("orchestrator", "Could not notify orphaned message", {
          chatId: orphan.chatId,
          error: String(err),
        });
      }
      await walDone(orphan.id);
    }
    if (orphans.length > 0) {
      log.info("orchestrator", `Reported ${orphans.length} orphaned message(s) from WAL`);
    }
  })().catch((err) => log.warn("orchestrator", "WAL orphan sweep failed", { error: String(err) }));

  let webServer: { stop(): void } | undefined;
  webServer = startWebApi({
    port: config.healthPort,
    runner,
    getConfig,
    reloadConfig: reloadConfigStore,
    apiToken,
  });
  // The scheduler reads agents through the store on every tick, so heartbeat
  // and task changes take effect without a restart.
  startScheduler(() => getConfig().agents.agents, runner, config.botToken, config.timezone);

  // Supervision: keep the live orchestrator session alive. Only meaningful in
  // orchestrator mode — in bot mode there is no session to supervise.
  let supervisorTimer: ReturnType<typeof setInterval> | undefined;
  if (orchestratorMode) {
    const o = config.orchestrator;
    const supervisor = new OrchestratorSupervisor({
      tmuxSession: o.tmuxSession,
      channelServer: o.channelServer,
      ...(o.cwd ? { cwd: o.cwd } : {}),
      ...(o.stateDir ? { stateDir: o.stateDir } : {}),
    });
    const tick = () =>
      supervisor
        .tick()
        .then((result) => {
          // Only log when something happened — a healthy tick every 30s would
          // drown the log and hide the interesting ones.
          if (!result.startsWith("none:")) {
            log.warn("supervisor", "supervision action", { result });
          }
        })
        .catch((err) => log.error("supervisor", "tick failed", { error: String(err) }));
    void tick();
    supervisorTimer = setInterval(tick, o.pollSeconds * 1000);
    log.info("supervisor", "Supervising orchestrator session", {
      tmuxSession: o.tmuxSession,
      everySeconds: o.pollSeconds,
    });
  }

  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // second signal while draining — ignore
    shuttingDown = true;
    log.info("orchestrator", "Shutting down gracefully...");

    // 1. Stop accepting new Telegram messages
    try {
      await botHandle?.stop();
    } catch (err) {
      log.warn("orchestrator", "Bot handle stop error (non-fatal)", { error: String(err) });
    }

    // 2. Stop supervising before draining — otherwise a shutting-down daemon
    //    could observe the orchestrator and "helpfully" restart it on the way out.
    if (supervisorTimer) clearInterval(supervisorTimer);

    // 3. Signal the runner to reject new queries
    runner.shutdown();

    // 4. Wait for in-flight queries to complete (max 30s)
    const drainTimeout = 30_000;
    try {
      await runner.drain(drainTimeout);
    } catch (err) {
      log.warn("orchestrator", "Drain did not complete cleanly", { error: String(err) });
    }

    // 4. Close web server if running
    if (webServer) {
      try {
        webServer.stop();
      } catch {
        // Already stopped
      }
    }

    // 5. Release lock
    await releaseLock();

    log.info("orchestrator", "Shutdown complete");
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Never let uncaught errors crash the orchestrator
  process.on("uncaughtException", (err) => {
    log.error("orchestrator", "Uncaught exception (non-fatal)", { error: String(err) });
  });
  process.on("unhandledRejection", (err) => {
    log.error("orchestrator", "Unhandled rejection (non-fatal)", { error: String(err) });
  });
}
