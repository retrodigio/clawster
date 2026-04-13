export function startHealthServer(agentCount: number, port: number): void {
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

  console.log(`Health server listening on http://localhost:${port}/health`);
}
