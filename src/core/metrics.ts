/**
 * Lightweight Prometheus-style metrics primitives.
 * Hand-rolled (no external deps) and exposed via GET /metrics.
 */

type LabelValues = Record<string, string | number>;

/** Serialize labels to Prometheus text format: {a="1",b="2"} (sorted for stability). */
function formatLabels(labels: LabelValues | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  if (keys.length === 0) return "";
  const pairs = keys.map((k) => {
    const v = String(labels[k]).replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    return `${k}="${v}"`;
  });
  return `{${pairs.join(",")}}`;
}

/** Stable key for a label set — used for internal maps. */
function labelKey(labels: LabelValues | undefined): string {
  if (!labels) return "";
  const keys = Object.keys(labels).sort();
  return keys.map((k) => `${k}=${labels[k]}`).join(",");
}

interface CounterEntry {
  labels: LabelValues | undefined;
  value: number;
}

class Counter {
  private entries = new Map<string, CounterEntry>();
  constructor(public readonly name: string, public readonly help: string) {}

  inc(labels?: LabelValues, by: number = 1): void {
    const key = labelKey(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.entries.set(key, { labels, value: by });
    }
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} counter`);
    if (this.entries.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.entries.values()) {
        lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }
    return lines.join("\n");
  }
}

interface GaugeEntry {
  labels: LabelValues | undefined;
  value: number;
}

class Gauge {
  private entries = new Map<string, GaugeEntry>();
  private provider: (() => void) | null = null;
  constructor(public readonly name: string, public readonly help: string) {}

  set(value: number, labels?: LabelValues): void {
    const key = labelKey(labels);
    this.entries.set(key, { labels, value });
  }

  inc(labels?: LabelValues, by: number = 1): void {
    const key = labelKey(labels);
    const existing = this.entries.get(key);
    if (existing) {
      existing.value += by;
    } else {
      this.entries.set(key, { labels, value: by });
    }
  }

  dec(labels?: LabelValues, by: number = 1): void {
    this.inc(labels, -by);
  }

  /** Register a callback that refreshes values just before scraping. */
  setProvider(fn: () => void): void {
    this.provider = fn;
  }

  render(): string {
    if (this.provider) {
      try { this.provider(); } catch { /* ignore provider errors */ }
    }
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} gauge`);
    if (this.entries.size === 0) {
      lines.push(`${this.name} 0`);
    } else {
      for (const entry of this.entries.values()) {
        lines.push(`${this.name}${formatLabels(entry.labels)} ${entry.value}`);
      }
    }
    return lines.join("\n");
  }
}

interface HistogramEntry {
  labels: LabelValues | undefined;
  counts: number[]; // cumulative per-bucket counts will be computed at render time from raw bucket hits
  bucketHits: number[]; // count of observations that fall into each bucket (non-cumulative)
  sum: number;
  count: number;
}

class Histogram {
  private entries = new Map<string, HistogramEntry>();
  constructor(
    public readonly name: string,
    public readonly help: string,
    public readonly buckets: number[], // upper bounds, sorted ascending
  ) {}

  observe(value: number, labels?: LabelValues): void {
    const key = labelKey(labels);
    let entry = this.entries.get(key);
    if (!entry) {
      entry = {
        labels,
        counts: new Array(this.buckets.length + 1).fill(0),
        bucketHits: new Array(this.buckets.length + 1).fill(0),
        sum: 0,
        count: 0,
      };
      this.entries.set(key, entry);
    }
    let placed = false;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        entry.bucketHits[i]!++;
        placed = true;
        break;
      }
    }
    if (!placed) {
      entry.bucketHits[this.buckets.length]!++; // +Inf bucket
    }
    entry.sum += value;
    entry.count++;
  }

  render(): string {
    const lines: string[] = [];
    lines.push(`# HELP ${this.name} ${this.help}`);
    lines.push(`# TYPE ${this.name} histogram`);
    if (this.entries.size === 0) {
      // Emit an empty histogram with zero counts for the +Inf bucket
      lines.push(`${this.name}_bucket{le="+Inf"} 0`);
      lines.push(`${this.name}_sum 0`);
      lines.push(`${this.name}_count 0`);
      return lines.join("\n");
    }
    for (const entry of this.entries.values()) {
      const baseLabels = entry.labels ?? {};
      let cumulative = 0;
      for (let i = 0; i < this.buckets.length; i++) {
        cumulative += entry.bucketHits[i]!;
        const le = this.buckets[i]!;
        const labels = { ...baseLabels, le: String(le) };
        lines.push(`${this.name}_bucket${formatLabels(labels)} ${cumulative}`);
      }
      cumulative += entry.bucketHits[this.buckets.length]!;
      const infLabels = { ...baseLabels, le: "+Inf" };
      lines.push(`${this.name}_bucket${formatLabels(infLabels)} ${cumulative}`);
      lines.push(`${this.name}_sum${formatLabels(entry.labels)} ${entry.sum}`);
      lines.push(`${this.name}_count${formatLabels(entry.labels)} ${entry.count}`);
    }
    return lines.join("\n");
  }
}

// --- Registry ---

export const messagesTotal = new Counter(
  "clawster_messages_total",
  "Total number of agent query invocations by outcome.",
);

// Buckets in seconds — covers quick replies through multi-minute sessions.
const DURATION_BUCKETS = [0.5, 1, 2, 5, 10, 30, 60, 120, 300, 600, 1800];

export const queryDurationSeconds = new Histogram(
  "clawster_query_duration_seconds",
  "Duration of agent query invocations in seconds.",
  DURATION_BUCKETS,
);

export const semaphoreQueueDepth = new Gauge(
  "clawster_semaphore_queue_depth",
  "Number of queued tasks waiting for a semaphore slot, by priority.",
);

export const semaphoreInFlight = new Gauge(
  "clawster_semaphore_in_flight",
  "Number of queries currently holding a semaphore slot.",
);

export const agentsConfigured = new Gauge(
  "clawster_agents_configured",
  "Number of agents currently configured.",
);

export const sessionsActive = new Gauge(
  "clawster_sessions_active",
  "Number of persisted sessions on disk.",
);

const registry: Array<Counter | Gauge | Histogram> = [
  messagesTotal,
  queryDurationSeconds,
  semaphoreQueueDepth,
  semaphoreInFlight,
  agentsConfigured,
  sessionsActive,
];

/** Render all metrics in Prometheus text exposition format. */
export function renderMetrics(): string {
  return registry.map((m) => m.render()).join("\n") + "\n";
}
