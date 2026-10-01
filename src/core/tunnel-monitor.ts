/**
 * The I/O half of Tailscale Funnel supervision. Policy lives in
 * tunnel-health.ts; this file observes, performs the chosen remedy, and sends
 * the alert. Nothing here needs sudo — the macOS Tailscale.app owns the
 * privileged part, and its bundled CLI talks to it as the logged-in user.
 *
 * Which Tailscale: this Mac also has Homebrew's `tailscaled`, whose user-level
 * LaunchAgent cannot run without root and has crash-looped since install. The
 * App's CLI is preferred; the two must never both be the active daemon.
 */

import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { log } from "./logger.ts";
import {
  decideTunnel,
  DEFAULT_TUNNEL_CONFIG,
  funnelServesDaemon,
  initialTunnelState,
  parseStatusJson,
  type TunnelHealthConfig,
  type TunnelObservation,
  type TunnelRemedy,
  type TunnelState,
} from "./tunnel-health.ts";

export const APP_CLI = "/Applications/Tailscale.app/Contents/MacOS/Tailscale";

export type Exec = (cmd: string[], timeoutMs?: number) => Promise<{ code: number; stdout: string; stderr: string }>;

export async function defaultExec(cmd: string[], timeoutMs = 20_000) {
  const p = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const timer = setTimeout(() => p.kill(), timeoutMs);
  try {
    const [stdout, stderr] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    const code = await p.exited;
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

export interface TunnelMonitorOptions {
  /** Daemon web API port the Funnel must proxy to. */
  port: number;
  /** Tailscale CLI. Empty = the App's CLI if installed, else `tailscale` on PATH. */
  tailscalePath?: string;
  /** Path prefix the Funnel exposes, e.g. "/api/hooks/". */
  funnelPath: string;
  /** Unauthenticated liveness path under funnelPath, fetched through the public URL. */
  probePath: string;
  /** Resolve the public hostname via public DNS so the probe takes the real Funnel ingress, not MagicDNS. */
  probeViaPublicDns: boolean;
  /** Where alerts go. */
  alert: (text: string) => Promise<void>;
  exec?: Exec;
  now?: () => number;
  config?: TunnelHealthConfig;
}

export function resolveTailscaleCli(configured?: string): string {
  if (configured) return configured;
  return existsSync(APP_CLI) ? APP_CLI : "tailscale";
}

export class TunnelMonitor {
  private state: TunnelState = initialTunnelState();
  private readonly exec: Exec;
  private readonly now: () => number;
  private readonly cli: string;
  private lastDnsName?: string;

  constructor(private readonly opts: TunnelMonitorOptions) {
    this.exec = opts.exec ?? defaultExec;
    this.now = opts.now ?? (() => Date.now());
    this.cli = resolveTailscaleCli(opts.tailscalePath);
  }

  getState(): TunnelState {
    return this.state;
  }

  async observe(): Promise<TunnelObservation> {
    const st = await this.exec([this.cli, "status", "--json"]).catch((e) => ({
      code: 1, stdout: "", stderr: String(e),
    }));
    let backend: string;
    let dnsName: string | undefined;
    let keyExpiry: number | undefined;
    try {
      ({ backend, dnsName, keyExpiry } = parseStatusJson(st.stdout));
    } catch {
      // No JSON at all: the CLI could not reach the App / tailscaled.
      return { backend: "unreachable" };
    }
    if (dnsName) this.lastDnsName = dnsName;
    if (backend !== "Running" || !dnsName) return { backend, ...(dnsName ? { dnsName } : {}) };
    const exp = keyExpiry !== undefined ? { keyExpiry } : {};

    const fs = await this.exec([this.cli, "funnel", "status", "--json"]).catch(() => ({
      code: 1, stdout: "", stderr: "",
    }));
    const funnelOk = funnelServesDaemon(fs.stdout, dnsName, this.opts.port, this.opts.funnelPath);
    if (!funnelOk) return { backend, dnsName, funnelOk, ...exp };

    return { backend, dnsName, funnelOk, ...exp, probe: await this.probe(dnsName) };
  }

  /**
   * Fetch the public probe URL with curl. curl rather than fetch because
   * `--resolve` lets us pin the public Funnel ingress address: from this Mac,
   * MagicDNS answers the ts.net name with the tailnet IP, which would test
   * `tailscale serve` but not whether the outside world can get in.
   */
  async probe(dnsName: string): Promise<{ ok: boolean; status?: number; error?: string }> {
    const nonce = randomBytes(8).toString("hex");
    const url = `https://${dnsName}${this.opts.probePath}?n=${nonce}`;
    const args = ["curl", "-sS", "-m", "15", "-w", "\n%{http_code}"];
    if (this.opts.probeViaPublicDns) {
      const dig = await this.exec(["dig", "+short", "@1.1.1.1", dnsName, "A"], 8_000).catch(() => null);
      const ip = dig?.stdout.split("\n").map((s) => s.trim()).find((s) => /^\d+\.\d+\.\d+\.\d+$/.test(s));
      if (ip) args.push("--resolve", `${dnsName}:443:${ip}`);
    }
    args.push(url);
    const r = await this.exec(args, 20_000).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const lines = r.stdout.split("\n");
    const status = Number(lines.pop());
    const body = lines.join("\n");
    if (r.code !== 0 || !status) {
      return { ok: false, error: (r.stderr.trim() || `curl exit ${r.code}`).slice(0, 200) };
    }
    // Only our own endpoint echoes the nonce — a Tailscale 502 page, a captive
    // portal or a stale cache cannot pass this.
    const ok = status === 200 && body.includes(nonce);
    return ok ? { ok, status } : { ok: false, status };
  }

  async remedy(r: TunnelRemedy): Promise<string> {
    let cmd: string[];
    switch (r) {
      case "launch-app":
        cmd = ["open", "-g", "-a", "Tailscale"];
        break;
      case "tailscale-up":
        // No flags: reuse saved prefs. Never passes --reset or auth keys.
        cmd = [this.cli, "up", "--timeout=30s"];
        break;
      case "apply-funnel": {
        const p = this.opts.funnelPath;
        cmd = [this.cli, "funnel", "--bg", `--set-path=${p}`, `http://127.0.0.1:${this.opts.port}${p}`];
        break;
      }
    }
    const res = await this.exec(cmd, 45_000).catch((e) => ({ code: 1, stdout: "", stderr: String(e) }));
    const out = `${res.stdout}\n${res.stderr}`.trim().replace(/\s+/g, " ").slice(0, 300);
    return `${r}: exit ${res.code}${out ? ` — ${out}` : ""}`;
  }

  async tick(): Promise<string> {
    const obs = await this.observe();
    if (!obs.dnsName && this.lastDnsName) obs.dnsName = this.lastDnsName;
    const d = decideTunnel(this.now(), obs, this.state, this.opts.config ?? DEFAULT_TUNNEL_CONFIG);
    this.state = d.state;

    let remedyResult: string | undefined;
    if (d.remedy) {
      remedyResult = await this.remedy(d.remedy);
      log.warn("tunnel", "remedy attempted", { problem: d.problem, result: remedyResult });
    }
    if (d.alert) {
      await this.opts.alert(d.alert).catch((e) =>
        log.warn("tunnel", "alert not delivered", { error: String(e) }),
      );
    }
    if (d.problem) log.warn("tunnel", "tunnel unhealthy", { summary: d.summary, probe: obs.probe });
    else if (d.summary !== "healthy") log.info("tunnel", d.summary);
    return remedyResult ? `${d.summary}; ${remedyResult}` : d.summary;
  }
}
