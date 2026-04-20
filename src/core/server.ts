import { join } from "path";
import { run, type RunnerHandle } from "@grammyjs/runner";
import { loadConfig, loadApiToken } from "./config.ts";
import { initRouter, resolveAgent } from "./router.ts";
import { createAgentRunner } from "./agent-runner.ts";
import { createBot } from "./bot.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { log } from "./logger.ts";
import { startWebApi } from "./web-api.ts";
import { startScheduler } from "./scheduler.ts";

export async function startServer() {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    log.error("orchestrator", "Failed to acquire lock — another instance may be running");
    process.exit(1);
  }

  const { config, agents, chatIdToAgent, agentById, defaultAgent } = await loadConfig();
  const apiToken = await loadApiToken();

  const unboundChatIds = new Set<string>(agents.unboundChatIds);
  initRouter(chatIdToAgent, defaultAgent, unboundChatIds, agents);

  const resolveAgentFn = (chatId: string, isPrivate: boolean) =>
    resolveAgent(chatId, isPrivate);

  // MCP config for Open Brain shared memory
  const mcpConfigPath = join(import.meta.dir, "..", "..", "config", "mcp-open-brain.json");

  const runner = createAgentRunner({
    maxConcurrent: config.maxConcurrent,
    mcpConfigPath,
  });

  const bot = createBot({
    botToken: config.botToken,
    allowedUserId: config.allowedUserId,
    groqKey: config.groqKey,
    resolveAgent: resolveAgentFn,
    runner,
    agentById,
  });

  // Mutable config reference for web API
  let loaded = { config, agents, chatIdToAgent, agentById, defaultAgent };

  const maskedToken = config.botToken.slice(0, 6) + "..." + config.botToken.slice(-4);
  log.info("orchestrator", "Starting orchestrator", {
    agents: agentById.size,
    botToken: maskedToken,
    allowedUserId: config.allowedUserId,
  });

  // Use @grammyjs/runner instead of bot.start() — the default sequentializes
  // update handlers, which means a slow Claude subprocess for one agent blocks
  // updates destined for every OTHER agent's chat. The runner dispatches each
  // update concurrently so a long-running reply in chat A can't starve chat B.
  // Concurrency of actual `claude -p` subprocesses remains bounded by the
  // runner's internal priority-aware semaphore (maxConcurrent).
  await bot.init();
  log.info("orchestrator", "Bot is running!");
  const botHandle: RunnerHandle = run(bot);

  let webServer: { stop(): void } | undefined;
  webServer = startWebApi({
    port: config.healthPort,
    runner,
    getConfig: () => loaded,
    reloadConfig: async () => {
      loaded = await loadConfig();
      return loaded;
    },
    apiToken,
  });
  startScheduler(agents.agents, runner, config.botToken, config.timezone);

  const shutdown = async () => {
    log.info("orchestrator", "Shutting down gracefully...");

    // 1. Stop accepting new Telegram messages
    try {
      await botHandle.stop();
    } catch (err) {
      log.warn("orchestrator", "Bot handle stop error (non-fatal)", { error: String(err) });
    }

    // 2. Signal the runner to reject new queries
    runner.shutdown();

    // 3. Wait for in-flight queries to complete (max 30s)
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
