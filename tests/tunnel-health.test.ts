import { describe, expect, test } from "bun:test";
import {
  classifyTunnel,
  decideTunnel,
  DEFAULT_TUNNEL_CONFIG,
  funnelServesDaemon,
  initialTunnelState,
  parseStatusJson,
  type TunnelObservation,
  type TunnelState,
} from "../src/core/tunnel-health.ts";
import { TunnelMonitor } from "../src/core/tunnel-monitor.ts";

const HOST = "chriss-2020-macbook-pro.tailbd6fc9.ts.net";
const healthy: TunnelObservation = { backend: "Running", dnsName: HOST, funnelOk: true, probe: { ok: true, status: 200 } };
const down: TunnelObservation = { backend: "unreachable" };

/** Run a sequence of observations one minute apart; return every decision. */
function run(observations: TunnelObservation[], start = 1_000_000, stepMs = 60_000) {
  let state: TunnelState = initialTunnelState();
  return observations.map((o, i) => {
    const d = decideTunnel(start + i * stepMs, o, state);
    state = d.state;
    return d;
  });
}

describe("classifyTunnel", () => {
  test("names the most upstream problem", () => {
    expect(classifyTunnel(healthy)).toBeUndefined();
    expect(classifyTunnel(down)).toBe("app-down");
    expect(classifyTunnel({ backend: "Stopped" })).toBe("stopped");
    expect(classifyTunnel({ backend: "NeedsLogin" })).toBe("needs-login");
    expect(classifyTunnel({ backend: "Starting" })).toBe("starting");
    expect(classifyTunnel({ ...healthy, funnelOk: false, probe: undefined })).toBe("funnel-missing");
    expect(classifyTunnel({ ...healthy, probe: { ok: false, status: 502 } })).toBe("probe-failed");
  });
});

describe("decideTunnel", () => {
  test("a single bad reading does nothing", () => {
    const [d] = run([down]);
    expect(d!.remedy).toBeUndefined();
    expect(d!.alert).toBeUndefined();
  });

  test("a blip that clears before confirmation never alerts", () => {
    const ds = run([down, healthy]);
    expect(ds.every((d) => !d.alert)).toBe(true);
  });

  test("confirmed outage: remedy and alert once, then back off", () => {
    const ds = run([down, down, down, down]);
    expect(ds[1]!.remedy).toBe("launch-app");
    expect(ds[1]!.alert).toContain("not running");
    // 5 minutes of backoff after the first attempt; ticks are 1 minute apart.
    expect(ds[2]!.remedy).toBeUndefined();
    expect(ds[3]!.remedy).toBeUndefined();
    expect(ds.filter((d) => d.alert).length).toBe(1);
  });

  test("remedies follow the backoff ladder", () => {
    const ticks = Array.from({ length: 120 }, () => down); // two hours of minutes
    const attempts = run(ticks).map((d, i) => (d.remedy ? i : -1)).filter((i) => i >= 0);
    // tick1 (confirm), +5m, +15m, +60m
    expect(attempts).toEqual([1, 6, 21, 81]);
  });

  test("login is never 'remedied' — it only alerts", () => {
    const ds = run([{ backend: "NeedsLogin" }, { backend: "NeedsLogin" }, { backend: "NeedsLogin" }]);
    expect(ds.some((d) => d.remedy)).toBe(false);
    expect(ds[1]!.alert).toContain("interactive login");
    expect(ds[1]!.alert).toContain("needs you");
  });

  test("re-alerts on a change of problem, and as a reminder after realertMs", () => {
    const ds = run([down, down, { backend: "NeedsLogin" }]);
    expect(ds[1]!.alert).toBeDefined();
    expect(ds[2]!.alert).toContain("logged out");

    const long = run(Array.from({ length: 2 + 6 * 60 }, () => down));
    const alerts = long.filter((d) => d.alert).length;
    expect(alerts).toBe(2); // first, then one reminder at the 6h mark
  });

  test("recovery after an alert says so; state resets", () => {
    const ds = run([down, down, healthy]);
    expect(ds[2]!.alert).toContain("serving again");
    expect(ds[2]!.state).toEqual(initialTunnelState());
  });

  test("Stopped → tailscale up; missing funnel → re-apply", () => {
    expect(run([{ backend: "Stopped" }, { backend: "Stopped" }])[1]!.remedy).toBe("tailscale-up");
    const nf = { ...healthy, funnelOk: false, probe: undefined };
    expect(run([nf, nf])[1]!.remedy).toBe("apply-funnel");
  });

  test("default config is the documented one", () => {
    expect(DEFAULT_TUNNEL_CONFIG.failuresBeforeAction).toBe(2);
  });
});

describe("parsers", () => {
  test("status --json", () => {
    expect(parseStatusJson(JSON.stringify({ BackendState: "Running", Self: { DNSName: HOST + "." } })))
      .toEqual({ backend: "Running", dnsName: HOST });
    expect(parseStatusJson(JSON.stringify({ BackendState: "NeedsLogin", Self: {} })))
      .toEqual({ backend: "NeedsLogin" });
    expect(() => parseStatusJson("failed to connect to local Tailscale service")).toThrow();
  });

  const serve = (handlers: Record<string, { Proxy?: string }>, funnel = true) =>
    JSON.stringify({
      TCP: { "443": { HTTPS: true } },
      Web: { [`${HOST}:443`]: { Handlers: handlers } },
      AllowFunnel: funnel ? { [`${HOST}:443`]: true } : {},
    });

  test("funnel status --json", () => {
    expect(funnelServesDaemon(serve({ "/api/hooks/": { Proxy: "http://127.0.0.1:18800/api/hooks/" } }), HOST, 18800, "/api/hooks/")).toBe(true);
    // Funnel off (tailnet-only serve) does not count.
    expect(funnelServesDaemon(serve({ "/api/hooks/": { Proxy: "http://127.0.0.1:18800/api/hooks/" } }, false), HOST, 18800)).toBe(false);
    // Proxying somewhere else does not count.
    expect(funnelServesDaemon(serve({ "/": { Proxy: "http://127.0.0.1:18789" } }), HOST, 18800)).toBe(false);
    // Whole-API exposure satisfies "serving" when no mount is required, not when one is.
    expect(funnelServesDaemon(serve({ "/": { Proxy: "http://127.0.0.1:18800" } }), HOST, 18800)).toBe(true);
    expect(funnelServesDaemon(serve({ "/": { Proxy: "http://127.0.0.1:18800" } }), HOST, 18800, "/api/hooks/")).toBe(false);
    expect(funnelServesDaemon("", HOST, 18800)).toBe(false);
    expect(funnelServesDaemon("{}", HOST, 18800)).toBe(false);
  });
});

describe("TunnelMonitor (fake exec)", () => {
  function monitor(script: (cmd: string[]) => { code: number; stdout: string; stderr?: string }) {
    const calls: string[][] = [];
    const alerts: string[] = [];
    let now = 1_000_000;
    const m = new TunnelMonitor({
      port: 18800,
      tailscalePath: "/fake/tailscale",
      funnelPath: "/api/hooks/",
      probePath: "/api/hooks/ping",
      probeViaPublicDns: true,
      alert: async (t) => { alerts.push(t); },
      now: () => (now += 60_000),
      exec: async (cmd) => {
        calls.push(cmd);
        const r = script(cmd);
        return { stderr: "", ...r };
      },
    });
    return { m, calls, alerts };
  }

  test("app down: launches the app on the confirming tick and alerts", async () => {
    const { m, calls, alerts } = monitor((cmd) =>
      cmd[1] === "status" ? { code: 1, stdout: "", stderr: "failed to connect" } : { code: 0, stdout: "" },
    );
    await m.tick();
    await m.tick();
    expect(calls.some((c) => c.join(" ") === "open -g -a Tailscale")).toBe(true);
    expect(alerts.length).toBe(1);
  });

  test("healthy: probe pins public DNS and requires the nonce echo", async () => {
    let probeArgs: string[] = [];
    const { m, alerts } = monitor((cmd) => {
      if (cmd[1] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: HOST + "." } }) };
      if (cmd[1] === "funnel") return { code: 0, stdout: JSON.stringify({
        Web: { [`${HOST}:443`]: { Handlers: { "/api/hooks/": { Proxy: "http://127.0.0.1:18800/api/hooks/" } } } },
        AllowFunnel: { [`${HOST}:443`]: true },
      }) };
      if (cmd[0] === "dig") return { code: 0, stdout: "100.0.0.9\n" };
      if (cmd[0] === "curl") {
        probeArgs = cmd;
        const nonce = new URL(cmd[cmd.length - 1]!).searchParams.get("n");
        return { code: 0, stdout: `{"ok":true,"nonce":"${nonce}"}\n200` };
      }
      return { code: 1, stdout: "" };
    });
    expect(await m.tick()).toBe("healthy");
    expect(probeArgs).toContain(`${HOST}:443:100.0.0.9`);
    expect(alerts).toEqual([]);
  });

  test("a 200 without our nonce is a failure (proxy page, cache)", async () => {
    const { m } = monitor((cmd) => {
      if (cmd[1] === "status") return { code: 0, stdout: JSON.stringify({ BackendState: "Running", Self: { DNSName: HOST } }) };
      if (cmd[1] === "funnel") return { code: 0, stdout: JSON.stringify({
        Web: { [`${HOST}:443`]: { Handlers: { "/api/hooks/": { Proxy: "http://127.0.0.1:18800/api/hooks/" } } } },
        AllowFunnel: { [`${HOST}:443`]: true },
      }) };
      if (cmd[0] === "curl") return { code: 0, stdout: "<html>ok</html>\n200" };
      return { code: 1, stdout: "" };
    });
    const p = await m.probe(HOST);
    expect(p.ok).toBe(false);
    expect(p.status).toBe(200);
  });
});
