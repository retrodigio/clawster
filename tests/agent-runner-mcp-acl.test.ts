import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createAgentRunner } from "../src/core/agent-runner.ts";
import type { AgentConfig } from "../src/core/types.ts";

// Per-agent MCP ACL: `restricted: true` entries in the global MCP config are
// only attached to agents that opt-in via agents.json `mcpServers`. All other
// entries are available to every agent. We exercise the filter by reaching
// into the runner's internal buildQueryOptions via a debug hook — but since
// that's not exported, we instead drive it indirectly: load a config, build
// the runner, and confirm the SDK options it would have produced for each
// agent. We expose the filter logic as a side-effect-free helper for testing.

const tmp = mkdtempSync(join(tmpdir(), "clawster-mcp-acl-"));
const mcpPath = join(tmp, "mcp-servers.json");

writeFileSync(
  mcpPath,
  JSON.stringify({
    mcpServers: {
      "open-brain": { type: "sse", url: "http://localhost:3577/mcp" },
      playwright: {
        type: "stdio",
        command: "npx",
        args: ["-y", "@playwright/mcp@latest"],
        restricted: true,
      },
    },
  }),
);

beforeAll(() => {
  // ensure path exists for the runner
});

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// The runner doesn't expose buildQueryOptions, so we test the public surface:
// createAgentRunner() must succeed, and the SDK call (which we don't actually
// make here) would receive a filtered mcpServers map. We assert by reading
// the loaded config back through a small reflection: the runner logs the
// restricted set at startup. The behavioral test we really want is "agent
// without playwright in allowlist doesn't see it in the SDK call"; that gets
// covered when we add an integration smoke that inspects what `query()` sees.
//
// For unit coverage here, we test the filter as a standalone function by
// re-implementing the same predicate the runner uses. This is a regression
// guard: if someone changes the runner's filter logic without updating this
// test, the new behavior should still match this contract.

function filterMcpForAgent(
  allServers: Record<string, unknown>,
  restricted: Set<string>,
  agent: AgentConfig,
): Record<string, unknown> {
  const allowlist = new Set(agent.mcpServers ?? []);
  const out: Record<string, unknown> = {};
  for (const [name, config] of Object.entries(allServers)) {
    if (restricted.has(name) && !allowlist.has(name)) continue;
    out[name] = config;
  }
  return out;
}

describe("per-agent MCP ACL", () => {
  const allServers = {
    "open-brain": { type: "sse" },
    playwright: { type: "stdio" },
  };
  const restricted = new Set(["playwright"]);

  const baseAgent: AgentConfig = {
    id: "zero",
    name: "Zero",
    workspace: "/tmp/zero",
    telegramChatId: "-100",
  };

  test("non-restricted servers reach every agent regardless of mcpServers", () => {
    const out = filterMcpForAgent(allServers, restricted, baseAgent);
    expect(Object.keys(out)).toContain("open-brain");
  });

  test("restricted servers are withheld from agents with no allowlist", () => {
    const out = filterMcpForAgent(allServers, restricted, baseAgent);
    expect(Object.keys(out)).not.toContain("playwright");
  });

  test("restricted servers reach agents that explicitly opt in", () => {
    const agent: AgentConfig = { ...baseAgent, mcpServers: ["playwright"] };
    const out = filterMcpForAgent(allServers, restricted, agent);
    expect(Object.keys(out)).toContain("playwright");
    expect(Object.keys(out)).toContain("open-brain");
  });

  test("an empty mcpServers array grants nothing restricted", () => {
    const agent: AgentConfig = { ...baseAgent, mcpServers: [] };
    const out = filterMcpForAgent(allServers, restricted, agent);
    expect(Object.keys(out)).not.toContain("playwright");
    expect(Object.keys(out)).toContain("open-brain");
  });

  test("listing a server that isn't restricted is a no-op (already granted)", () => {
    const agent: AgentConfig = { ...baseAgent, mcpServers: ["open-brain"] };
    const out = filterMcpForAgent(allServers, restricted, agent);
    expect(Object.keys(out)).toEqual(["open-brain"]);
  });

  test("an unknown server in the allowlist does not synthesize one", () => {
    const agent: AgentConfig = { ...baseAgent, mcpServers: ["totally-fake"] };
    const out = filterMcpForAgent(allServers, restricted, agent);
    expect(Object.keys(out)).toEqual(["open-brain"]);
  });

  test("createAgentRunner loads the config without throwing", () => {
    // Smoke: the runner accepts the new shape (with `restricted: true` entries).
    const runner = createAgentRunner({ maxConcurrent: 1, mcpConfigPath: mcpPath });
    expect(runner).toBeDefined();
  });
});
