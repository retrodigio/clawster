import { join } from "path";
import { readdir } from "fs/promises";
import { log } from "./logger.ts";
import {
  getClawsterHome,
  loadConfig,
  saveAgents,
  saveConfig,
  type AgentsConfig,
  type ClawsterConfig,
  type LoadedConfig,
} from "./config.ts";
import { getSession, clearSession } from "./session-store.ts";
import type { AgentConfig } from "./types.ts";
import type { ActivityStatus, ConversationEvent, QueryPriority } from "./agent-runner.ts";
import { renderMetrics, agentsConfigured, sessionsActive } from "./metrics.ts";

type AgentRunner = {
  run: (
    agent: AgentConfig,
    prompt: string,
    options?: { topicId?: number; timeout?: number; priority?: QueryPriority },
  ) => Promise<string>;
  runStreaming: (
    agent: AgentConfig,
    prompt: string,
    onUpdate: (textSoFar: string) => void,
    options?: {
      topicId?: number;
      timeout?: number;
      priority?: QueryPriority;
      onActivity?: (status: ActivityStatus) => void;
      onEvent?: (event: ConversationEvent) => void;
    },
  ) => Promise<{ text: string; sessionId: string | null }>;
};

interface WebApiOptions {
  port: number;
  runner: AgentRunner;
  getConfig: () => LoadedConfig;
  reloadConfig: () => Promise<LoadedConfig>;
  apiToken: string;
}

/** Parse JSON body safely. */
async function parseBody<T = any>(req: Request): Promise<T | null> {
  try {
    return (await req.json()) as T;
  } catch {
    return null;
  }
}

/** JSON response helper. */
function json(data: unknown, status = 200): Response {
  return Response.json(data, { status });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

/** CORS headers for dev mode (Vite on :5173 → API on :18800). */
const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function withCors(res: Response): Response {
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    res.headers.set(k, v);
  }
  return res;
}

export function startWebApi(options: WebApiOptions) {
  const { port, runner, apiToken } = options;
  let currentConfig = options.getConfig;
  const reloadConfig = options.reloadConfig;

  /** Check Bearer token from Authorization header. */
  function checkBearerAuth(req: Request): boolean {
    const auth = req.headers.get("authorization");
    if (!auth) return false;
    const [scheme, token] = auth.split(" ");
    return scheme === "Bearer" && token === apiToken;
  }

  /** Check token from query parameter (for WebSocket connections). */
  function checkQueryAuth(url: URL): boolean {
    return url.searchParams.get("token") === apiToken;
  }

  /** Check if request originates from localhost. */
  function isLocalhost(req: Request): boolean {
    const host = req.headers.get("host") || "";
    return host.startsWith("localhost") || host.startsWith("127.0.0.1");
  }

  // Track active WebSocket connections per agent
  const activeWsConnections = new Map<string, Set<{ ws: any; close: () => void }>>();

  const server = Bun.serve({
    port,
    fetch(req, server) {
      const url = new URL(req.url);
      const path = url.pathname;

      // CORS preflight
      if (req.method === "OPTIONS") {
        return withCors(new Response(null, { status: 204 }));
      }

      // Skip auth for health endpoint (monitoring)
      // Skip auth for /metrics (standard Prometheus scrape convention)
      // Skip auth for static files (web UI serves itself, uses token in API calls)
      // Require auth for /api/* and /ws/*

      // Prometheus metrics endpoint — unauthenticated (standard scrape convention; localhost-only by default).
      if (path === "/metrics" && req.method === "GET") {
        return (async () => {
          try {
            const cfg = currentConfig();
            agentsConfigured.set(cfg.agentById.size);
            const sessionsDir = join(getClawsterHome(), "sessions");
            try {
              const files = await readdir(sessionsDir);
              sessionsActive.set(files.filter((f) => f.endsWith(".json")).length);
            } catch { /* sessions dir may not exist yet */ }
          } catch { /* best-effort refresh */ }
          return withCors(new Response(renderMetrics(), {
            status: 200,
            headers: { "Content-Type": "text/plain; version=0.0.4; charset=utf-8" },
          }));
        })();
      }

      // WebSocket upgrade for chat — authenticate via query param
      if (path.startsWith("/ws/chat/")) {
        if (!checkQueryAuth(url)) {
          return withCors(err("Unauthorized", 401));
        }

        const agentId = path.split("/ws/chat/")[1];
        if (!agentId) return withCors(err("Missing agent ID"));

        const cfg = currentConfig();
        const agent = cfg.agentById.get(agentId);
        if (!agent) return withCors(err("Agent not found", 404));

        const upgraded = server.upgrade(req, { data: { agentId, agent } } as any);
        if (!upgraded) return withCors(err("WebSocket upgrade failed", 500));
        return undefined as unknown as Response;
      }

      // Serve static files for the web UI (no auth required)
      if (!path.startsWith("/api/") && !path.startsWith("/ws/") && path !== "/health") {
        return serveStatic(path);
      }

      // Auth check for /api/* endpoints (except /health and /api/auth/token)
      if (path.startsWith("/api/") && path !== "/api/auth/token") {
        if (!checkBearerAuth(req)) {
          return withCors(err("Unauthorized", 401));
        }
      }

      return handleApi(req, url, path);
    },

    websocket: {
      open(ws: any) {
        const { agentId } = ws.data as { agentId: string; agent: AgentConfig };
        log.info("web-api", `WebSocket opened for agent ${agentId}`);

        if (!activeWsConnections.has(agentId)) {
          activeWsConnections.set(agentId, new Set());
        }
        activeWsConnections.get(agentId)!.add({ ws, close: () => ws.close() });
      },

      async message(ws: any, message: string | Buffer) {
        const { agentId, agent } = ws.data as { agentId: string; agent: AgentConfig };
        let parsed: { prompt?: string; topicId?: number };
        try {
          parsed = JSON.parse(typeof message === "string" ? message : message.toString());
        } catch {
          ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
          return;
        }

        if (!parsed.prompt) {
          ws.send(JSON.stringify({ type: "error", message: "Missing prompt" }));
          return;
        }

        ws.send(JSON.stringify({ type: "start", agentId }));

        // Emit user event for the incoming message
        ws.send(JSON.stringify({
          type: "event",
          event: {
            id: crypto.randomUUID(),
            type: "user",
            timestamp: new Date().toISOString(),
            data: { text: parsed.prompt },
          },
        }));

        try {
          const result = await runner.runStreaming(
            agent,
            parsed.prompt,
            (textSoFar: string) => {
              ws.send(JSON.stringify({ type: "stream", text: textSoFar }));
            },
            {
              topicId: parsed.topicId,
              onActivity: (status) => {
                ws.send(JSON.stringify({ ...status, type: "activity", activityType: status.type }));
              },
              onEvent: (event) => {
                ws.send(JSON.stringify({ type: "event", event }));
              },
            },
          );

          ws.send(JSON.stringify({ type: "done", text: result.text, sessionId: result.sessionId }));
        } catch (error) {
          ws.send(JSON.stringify({ type: "error", message: String(error) }));
        }
      },

      close(ws: any) {
        const { agentId } = ws.data as { agentId: string };
        log.info("web-api", `WebSocket closed for agent ${agentId}`);
        const conns = activeWsConnections.get(agentId);
        if (conns) {
          for (const conn of conns) {
            if (conn.ws === ws) {
              conns.delete(conn);
              break;
            }
          }
        }
      },
    },
  });

  async function serveStatic(path: string): Promise<Response> {
    const webDir = join(import.meta.dir, "..", "..", "dist", "web");
    let filePath = join(webDir, path === "/" ? "index.html" : path);

    const file = Bun.file(filePath);
    if (await file.exists()) {
      return withCors(new Response(file));
    }

    // SPA fallback — serve index.html for client-side routes
    const indexFile = Bun.file(join(webDir, "index.html"));
    if (await indexFile.exists()) {
      return withCors(new Response(indexFile));
    }

    return withCors(err("Not found", 404));
  }

  async function handleApi(req: Request, url: URL, path: string): Promise<Response> {
    const method = req.method;

    // GET /api/auth/token — return token only to localhost requests
    if (path === "/api/auth/token" && method === "GET") {
      if (!isLocalhost(req)) {
        return withCors(err("Forbidden — token only available from localhost", 403));
      }
      return withCors(json({ token: apiToken }));
    }

    // Health
    if (path === "/health") {
      const cfg = currentConfig();
      return withCors(json({
        status: "ok",
        uptime: process.uptime(),
        agents: cfg.agentById.size,
        pid: process.pid,
      }));
    }

    // GET /api/agents — list all agents
    if (path === "/api/agents" && method === "GET") {
      const cfg = currentConfig();
      return withCors(json(cfg.agents.agents));
    }

    // GET /api/agents/:id — single agent
    if (path.match(/^\/api\/agents\/[^/]+$/) && method === "GET") {
      const id = path.split("/api/agents/")[1]!;
      const cfg = currentConfig();
      const agent = cfg.agentById.get(id);
      if (!agent) return withCors(err("Agent not found", 404));
      return withCors(json(agent));
    }

    // POST /api/agents — add agent
    if (path === "/api/agents" && method === "POST") {
      const body = await parseBody<Partial<AgentConfig>>(req);
      if (!body?.name || !body?.workspace) {
        return withCors(err("name and workspace are required"));
      }

      const cfg = currentConfig();
      const id = body.id || body.name.toLowerCase().replace(/[^a-z0-9-]/g, "-");

      if (cfg.agentById.has(id)) {
        return withCors(err(`Agent "${id}" already exists`, 409));
      }

      const newAgent: AgentConfig = {
        id,
        name: body.name,
        workspace: body.workspace,
        telegramChatId: body.telegramChatId || "",
        ...(body.isDefault ? { isDefault: true } : {}),
        ...(body.topics ? { topics: body.topics } : {}),
        ...(body.heartbeat ? { heartbeat: body.heartbeat } : {}),
        ...(body.tasks ? { tasks: body.tasks } : {}),
      };

      cfg.agents.agents.push(newAgent);
      await saveAgents(cfg.agents);
      const reloaded = await reloadConfig();
      return withCors(json(newAgent, 201));
    }

    // PUT /api/agents/:id — update agent
    if (path.match(/^\/api\/agents\/[^/]+$/) && method === "PUT") {
      const id = path.split("/api/agents/")[1]!;
      const cfg = currentConfig();
      const idx = cfg.agents.agents.findIndex((a) => a.id === id);
      if (idx === -1) return withCors(err("Agent not found", 404));

      const body = await parseBody<Partial<AgentConfig>>(req);
      if (!body) return withCors(err("Invalid body"));

      const existing = cfg.agents.agents[idx]!;
      const updated: AgentConfig = {
        ...existing,
        ...body,
        id, // ID is immutable
      };

      cfg.agents.agents[idx] = updated;
      await saveAgents(cfg.agents);
      await reloadConfig();
      return withCors(json(updated));
    }

    // DELETE /api/agents/:id — remove agent
    if (path.match(/^\/api\/agents\/[^/]+$/) && method === "DELETE") {
      const id = path.split("/api/agents/")[1]!;
      const cfg = currentConfig();
      const idx = cfg.agents.agents.findIndex((a) => a.id === id);
      if (idx === -1) return withCors(err("Agent not found", 404));

      cfg.agents.agents.splice(idx, 1);
      await saveAgents(cfg.agents);
      await reloadConfig();
      return withCors(json({ ok: true }));
    }

    // GET /api/sessions — all sessions
    if (path === "/api/sessions" && method === "GET") {
      const sessionsDir = join(getClawsterHome(), "sessions");
      const sessions: Record<string, any> = {};
      try {
        const files = await readdir(sessionsDir);
        for (const f of files) {
          if (!f.endsWith(".json")) continue;
          const key = f.replace(".json", "");
          try {
            const data = await Bun.file(join(sessionsDir, f)).json();
            sessions[key] = data;
          } catch { /* skip corrupt files */ }
        }
      } catch { /* sessions dir doesn't exist yet */ }
      return withCors(json(sessions));
    }

    // GET /api/sessions/:agentId — single agent session
    if (path.match(/^\/api\/sessions\/[^/]+$/) && method === "GET") {
      const agentId = path.split("/api/sessions/")[1]!;
      const session = await getSession(agentId);
      return withCors(json(session));
    }

    // GET /api/sessions/:agentId/events — conversation events (stub for future persistence)
    if (path.match(/^\/api\/sessions\/[^/]+\/events$/) && method === "GET") {
      return withCors(json([]));
    }

    // DELETE /api/sessions/:agentId — clear session
    if (path.match(/^\/api\/sessions\/[^/]+$/) && method === "DELETE") {
      const agentId = path.split("/api/sessions/")[1]!;
      await clearSession(agentId);
      return withCors(json({ ok: true }));
    }

    // GET /api/config — read config (masks secrets)
    if (path === "/api/config" && method === "GET") {
      const cfg = currentConfig();
      const maskedGroqKey = cfg.config.groqKey
        ? cfg.config.groqKey.slice(0, 4) + "..." + cfg.config.groqKey.slice(-4)
        : "";
      return withCors(json({
        ...cfg.config,
        botToken: cfg.config.botToken.slice(0, 6) + "..." + cfg.config.botToken.slice(-4),
        groqKey: maskedGroqKey,
      }));
    }

    // PATCH /api/config — update config
    if (path === "/api/config" && method === "PATCH") {
      const body = await parseBody<Partial<ClawsterConfig>>(req);
      if (!body) return withCors(err("Invalid body"));

      const cfg = currentConfig();
      const updated: ClawsterConfig = {
        ...cfg.config,
        ...body,
        // Don't allow overwriting token with masked version
        botToken: body.botToken?.includes("...") ? cfg.config.botToken : (body.botToken || cfg.config.botToken),
      };

      await saveConfig(updated);
      await reloadConfig();
      return withCors(json({
        ...updated,
        botToken: updated.botToken.slice(0, 6) + "..." + updated.botToken.slice(-4),
      }));
    }

    // POST /api/hooks/deliver — OpenClaw-compatible webhook delivery endpoint.
    // Accepts payload: { message, name?, deliver?, channel: "telegram", to, topic_id?, agentId? }
    // On `channel: "telegram"` → splits message and POSTs to Telegram Bot API.
    // If `agentId` is present → fires the message at the agent runner (fire-and-forget).
    if (path === "/api/hooks/deliver" && method === "POST") {
      const body = await parseBody<{
        message?: string;
        name?: string;
        deliver?: boolean;
        channel?: string;
        to?: string;
        topic_id?: string | number;
        agentId?: string;
      }>(req);
      if (!body) return withCors(err("Invalid JSON body"));
      if (!body.message) return withCors(err("Missing 'message'"));
      if (body.channel && body.channel !== "telegram") {
        return withCors(err(`Unsupported channel '${body.channel}' (only 'telegram' is supported)`));
      }
      if (!body.to) return withCors(err("Missing 'to' (chat ID)"));

      const cfg = currentConfig();
      const botToken = cfg.config.botToken;
      const topicId = body.topic_id ? Number(body.topic_id) : undefined;
      const prefix = body.name ? `*${body.name}*\n` : "";
      const fullMessage = prefix + body.message;

      // Split into Telegram-sized chunks (hard limit 4096; use 4000 for safety margin)
      const MAX = 4000;
      const chunks: string[] = [];
      for (let i = 0; i < fullMessage.length; i += MAX) {
        chunks.push(fullMessage.slice(i, i + MAX));
      }

      let delivered = 0;
      const errors: string[] = [];
      for (const chunk of chunks) {
        const payload: Record<string, unknown> = {
          chat_id: body.to,
          text: chunk,
        };
        if (topicId) payload.message_thread_id = topicId;
        try {
          const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (resp.ok) {
            delivered++;
          } else {
            errors.push(`HTTP ${resp.status}: ${await resp.text()}`);
          }
        } catch (e) {
          errors.push(String(e));
        }
      }

      // Optional agent-reactive mode — hand the message to an agent for triage/action
      if (body.agentId) {
        const agent = cfg.agentById.get(body.agentId);
        if (agent) {
          runner.run(agent, body.message, { topicId }).catch((e) =>
            log.error("web-api", `Hook agent run failed: ${e}`, { agentId: body.agentId }),
          );
        } else {
          log.warn("web-api", `Hook agentId '${body.agentId}' not found`);
        }
      }

      log.info("web-api", `Hook delivered: ${delivered}/${chunks.length} chunks to ${body.to}`, {
        source: body.name,
        topicId,
      });

      if (errors.length > 0) {
        return withCors(json({ ok: false, delivered, total: chunks.length, errors }, 502));
      }
      return withCors(json({ ok: true, delivered, total: chunks.length }));
    }

    // GET /api/status — overall system status
    if (path === "/api/status" && method === "GET") {
      const cfg = currentConfig();
      const sessionsDir = join(getClawsterHome(), "sessions");
      let sessionCount = 0;
      try {
        const files = await readdir(sessionsDir);
        sessionCount = files.filter((f) => f.endsWith(".json")).length;
      } catch { /* no sessions yet */ }

      return withCors(json({
        status: "ok",
        uptime: process.uptime(),
        agentCount: cfg.agentById.size,
        sessionCount,
        maxConcurrent: cfg.config.maxConcurrent,
        pid: process.pid,
        timezone: cfg.config.timezone,
      }));
    }

    return withCors(err("Not found", 404));
  }

  const tokenPath = join(getClawsterHome(), "api-token");
  log.info("web-api", `Web API server listening on port ${port}`, { apiTokenPath: tokenPath });
  return server;
}
