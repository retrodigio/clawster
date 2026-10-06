import { describe, expect, test } from "bun:test";
import {
  classifyTunnel,
  decideTunnel,
  DEFAULT_TUNNEL_CONFIG,
  funnelServesDaemon,
  initialTunnelState,
  parseStatusJson,
  detectSleepGap,
  evaluateWakeGrace,
  parsePmsetLog,
  WAKE_GRACE_MS,
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

  test("warns ahead of key expiry, rate-limited, surviving recovery resets", () => {
    const DAY = 86_400_000;
    let state = initialTunnelState();
    const at = (now: number, expiry: number) => {
      const d = decideTunnel(now, { ...healthy, keyExpiry: expiry }, state);
      state = d.state;
      return d;
    };
    const expiry = 100 * DAY;
    expect(at(80 * DAY, expiry).alert).toBeUndefined(); // 20 days out
    expect(at(87 * DAY, expiry).alert).toContain("expires in 13 day(s)");
    expect(at(88 * DAY, expiry).alert).toBeUndefined(); // within rewarn window
    expect(at(90 * DAY, expiry).alert).toContain("expires in 10 day(s)");
    // An outage + recovery in between must not re-arm the warning early.
    state = decideTunnel(90 * DAY + 1, down, state).state;
    state = decideTunnel(90 * DAY + 2, down, state).state;
    const rec = decideTunnel(90 * DAY + 3, { ...healthy, keyExpiry: expiry }, state);
    expect(rec.alert).toContain("serving again");
    expect(rec.alert).not.toContain("expires");
  });

  test("default config is the documented one", () => {
    expect(DEFAULT_TUNNEL_CONFIG.failuresBeforeAction).toBe(2);
  });
});

describe("parsers", () => {
  test("status --json", () => {
    expect(parseStatusJson(JSON.stringify({ BackendState: "Running", Self: { DNSName: HOST + "." } })))
      .toEqual({ backend: "Running", dnsName: HOST });
    expect(parseStatusJson(JSON.stringify({ BackendState: "Running", Self: { DNSName: HOST, KeyExpiry: "2027-03-30T14:55:40Z" } })).keyExpiry)
      .toBe(Date.parse("2027-03-30T14:55:40Z"));
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

describe("sleep awareness", () => {
  const IV = 60_000;

  test("gap detection: strictly more than 2x the interval", () => {
    expect(detectSleepGap(undefined, 1_000_000, IV)).toBe(false);
    expect(detectSleepGap(1_000_000, 1_000_000 + IV, IV)).toBe(false);
    expect(detectSleepGap(1_000_000, 1_000_000 + 2 * IV, IV)).toBe(false);
    expect(detectSleepGap(1_000_000, 1_000_000 + 2 * IV + 1, IV)).toBe(true);
    expect(detectSleepGap(1_000_000, 1_000_000 + 3_600_000, IV)).toBe(true);
  });

  test("grace opens on a gap, lasts ~3 min, logs fresh once", () => {
    let st = evaluateWakeGrace(0, { graceUntil: 0 }, IV).state;
    const a = evaluateWakeGrace(600_000, st, IV);
    expect(a.quiet).toBe(true);
    expect(a.fresh).toBe(true);
    expect(a.reason).toBe("gap");
    const b = evaluateWakeGrace(600_000 + IV, a.state, IV);
    expect(b.quiet).toBe(true);
    expect(b.fresh).toBe(false);
    const c = evaluateWakeGrace(600_000 + 2 * IV, b.state, IV);
    expect(c.quiet).toBe(true);
    const d = evaluateWakeGrace(600_000 + 3 * IV + 1, c.state, IV); // grace is 3 min
    expect(d.quiet).toBe(false);
    expect(d.fresh).toBe(false);
  });

  test("DarkWake keeps it quiet; a stale DarkWake line does not", () => {
    const now = 10_000_000;
    const prev = { lastTickAt: now - IV, graceUntil: 0 };
    expect(evaluateWakeGrace(now, prev, IV, { kind: "darkwake", at: now - 30_000 }).quiet).toBe(true);
    expect(evaluateWakeGrace(now, prev, IV, { kind: "darkwake", at: now - 3_600_000 }).quiet).toBe(false);
    expect(evaluateWakeGrace(now, prev, IV, { kind: "sleep", at: now - 1_000 }).quiet).toBe(false);
    expect(evaluateWakeGrace(now, prev, IV, { kind: "wake", at: now - 60_000 }).quiet).toBe(true);
    expect(evaluateWakeGrace(now, prev, IV, { kind: "wake", at: now - 600_000 }).quiet).toBe(false);
  });

  test("parsePmsetLog takes the latest Sleep/DarkWake/Wake and ignores Wake Requests", () => {
    const out = [
      "2026-10-06 11:39:02 -0600 DarkWake            \tDarkWake from Deep Idle",
      "2026-10-06 11:39:47 -0600 Sleep               \tEntering Sleep state",
      "2026-10-06 11:39:50 -0600 Wake Requests       \t[process=dasd]",
      "2026-10-06 11:48:45 -0600 Wake                \tWake from Deep Idle",
      "2026-10-06 11:49:00 -0600 Assertions          \tfoo",
    ].join("\n");
    expect(parsePmsetLog(out)).toEqual({ kind: "wake", at: Date.parse("2026-10-06T11:48:45-06:00") });
    expect(parsePmsetLog(out.split("\n").slice(0, 3).join("\n"))?.kind).toBe("sleep");
    expect(parsePmsetLog("garbage")).toBeUndefined();
  });

  describe("monitor", () => {
    function mon(pmset = "") {
      const calls: string[][] = [];
      const alerts: string[] = [];
      let t = 100_000_000;
      const m = new TunnelMonitor({
        port: 18800, tailscalePath: "/fake/ts", funnelPath: "/api/hooks/", probePath: "/api/hooks/ping",
        probeViaPublicDns: false, pollSeconds: 60,
        alert: async (x) => { alerts.push(x); },
        now: () => t,
        exec: async (cmd) => {
          calls.push(cmd);
          if (cmd[0] === "pmset") return { code: 0, stdout: pmset, stderr: "" };
          // Tailscale app unreachable: always a failing reading.
          if (cmd[1] === "status") return { code: 1, stdout: "", stderr: "no" };
          return { code: 0, stdout: "", stderr: "" };
        },
      });
      return { m, calls, alerts, advance: (ms: number) => { t += ms; } };
    }

    test("failures right after a sleep gap: no count, alert or remedy; alerts after grace", async () => {
      const { m, calls, alerts, advance } = mon();
      await m.tick();             // reading 1, normal cadence
      advance(3_600_000);         // slept an hour
      expect(await m.tick()).toContain("post-wake grace");
      advance(60_000);
      expect(await m.tick()).toContain("post-wake grace");
      expect(m.getState().consecutiveFailures).toBe(0);
      expect(alerts).toEqual([]);
      expect(calls.some((c) => c[0] === "open")).toBe(false);
      advance(60_000);
      await m.tick();             // still inside the 3 min window
      advance(60_000);
      await m.tick();             // grace over, machine awake, still failing
      expect(alerts.length).toBe(0);
      expect(alerts.length).toBe(0); // reading 1 of 2
      advance(60_000);
      await m.tick();
      expect(alerts.length).toBe(1);
      expect(calls.some((c) => c.join(" ") === "open -g -a Tailscale")).toBe(true);
    });

    test("DarkWake per pmset suppresses even without a gap", async () => {
      const now = 100_000_000;
      const { m, alerts, advance } = mon(`${new Date(now - 20_000).toISOString().slice(0, 19).replace("T", " ")} +0000 DarkWake            \tx`);
      await m.tick();
      advance(60_000);
      expect(await m.tick()).toContain("post-wake grace");
      expect(alerts).toEqual([]);
    });
  });
});
