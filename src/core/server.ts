import { join } from "path";
import { loadConfig, getClawsterHome } from "./config.ts";
import { initRouter, resolveAgent } from "./router.ts";
import { createAgentRunner } from "./agent-runner.ts";
import { createBot } from "./bot.ts";
import { acquireLock, releaseLock } from "./lock.ts";
import { log } from "./logger.ts";
import { startHealthServer } from "./health.ts";
import { startHeartbeats } from "./heartbeat.ts";

export async function startServer() {
  const lockAcquired = await acquireLock();
  if (!lockAcquired) {
    log.error("orchestrator", "Failed to acquire lock — another instance may be running");
    process.exit(1);
  }

  const { config, agents, chatIdToAgent, agentById, defaultAgent } = await loadConfig();

  const unboundChatIds = new Set<string>(agents.unboundChatIds);
  initRouter(chatIdToAgent, defaultAgent, unboundChatIds);

  const resolveAgentFn = (chatId: string, isPrivate: boolean) =>
    resolveAgent(chatId, isPrivate);

  // TODO Phase 2: Add stdio-based MCP wrapper for Open Brain
  // For now, agents use `ob` CLI directly for memory operations
  const mcpConfigPath = "";

  const runner = createAgentRunner({
    maxConcurrent: config.maxConcurrent,
    mcpConfigPath,
    claudePath: config.claudePath,
  });

  const bot = createBot({
    botToken: config.botToken,
    allowedUserId: config.allowedUserId,
    resolveAgent: resolveAgentFn,
    runner,
    agentById,
  });

  const maskedToken = config.botToken.slice(0, 6) + "..." + config.botToken.slice(-4);
  log.info("orchestrator", "Starting orchestrator", {
    agents: agentById.size,
    botToken: maskedToken,
    allowedUserId: config.allowedUserId,
  });

  bot.start({
    onStart: () => {
      log.info("orchestrator", "Bot is running!");
      startHealthServer(agentById.size, config.healthPort);
      startHeartbeats(agents.agents, runner, config.botToken, config.timezone);
    },
  });

  const shutdown = async () => {
    log.info("orchestrator", "Shutting down...");
    bot.stop();
    await releaseLock();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
