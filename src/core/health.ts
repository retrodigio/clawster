import { log } from "./logger.ts";

export function startHealthServer(agentCount: number, port: number): void {
  try {
    Bun.serve({
      port,
      fetch(req) {
        const url = new URL(req.url);

        if (url.pathname === "/health") {
          return Response.json({
            status: "ok",
            uptime: process.uptime(),
            agents: agentCount,
            pid: process.pid,
          });
        }

        return new Response("Not Found", { status: 404 });
      },
    });

    log.info("system", `Health server listening on port ${port}`);
  } catch (err) {
    // Don't crash the whole orchestrator if the health port is busy
    log.warn("system", `Health server failed to start on port ${port}`, {
      error: String(err),
    });
  }
}
