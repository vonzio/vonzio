import { lt } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

interface MetricEntry {
  type: "counter" | "gauge" | "histogram";
  value: number;
  labels: Record<string, string>;
}

export class MetricsCollector {
  private metrics = new Map<string, MetricEntry>();
  private histogramBuckets = new Map<string, number[]>();
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private retentionDays: number;

  constructor(private db?: DrizzleDB, opts?: { retentionDays?: number }) {
    this.retentionDays = opts?.retentionDays ?? 7;
  }

  counter(name: string, labels: Record<string, string> = {}, increment = 1): void {
    const key = this.makeKey(name, labels);
    const existing = this.metrics.get(key);
    if (existing && existing.type === "counter") {
      existing.value += increment;
    } else {
      this.metrics.set(key, { type: "counter", value: increment, labels });
    }
  }

  gauge(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);
    this.metrics.set(key, { type: "gauge", value, labels });
  }

  histogram(name: string, value: number, labels: Record<string, string> = {}): void {
    const key = this.makeKey(name, labels);
    const existing = this.metrics.get(key);
    if (existing && existing.type === "histogram") {
      existing.value = value; // Latest value for snapshot
    } else {
      this.metrics.set(key, { type: "histogram", value, labels });
    }

    // Store individual values for percentile calculations
    const bucketKey = `${name}:${JSON.stringify(labels)}`;
    const buckets = this.histogramBuckets.get(bucketKey) ?? [];
    buckets.push(value);
    this.histogramBuckets.set(bucketKey, buckets);
  }

  getAll(): { name: string; type: string; value: number; labels: Record<string, string> }[] {
    const result: { name: string; type: string; value: number; labels: Record<string, string> }[] = [];
    for (const [key, entry] of this.metrics) {
      const name = key.split("{")[0];
      result.push({ name, type: entry.type, value: entry.value, labels: entry.labels });
    }
    return result;
  }

  get(name: string, labels: Record<string, string> = {}): number | undefined {
    const key = this.makeKey(name, labels);
    return this.metrics.get(key)?.value;
  }

  startPeriodicFlush(intervalMs: number): void {
    this.flushInterval = setInterval(() => { this.flush().catch(() => {}); }, intervalMs);
  }

  stop(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
  }

  async flush(): Promise<void> {
    if (!this.db) return;

    const now = new Date().toISOString();
    for (const [key, entry] of this.metrics) {
      const name = key.split("{")[0];
      await this.db
        .insert(schema.metrics)
        .values({
          name,
          value: entry.value,
          labels: entry.labels,
          timestamp: now,
        });
    }

    // Prune old metrics
    const cutoff = new Date(Date.now() - this.retentionDays * 86_400_000).toISOString();
    await this.db.delete(schema.metrics).where(lt(schema.metrics.timestamp, cutoff));
  }

  toPrometheus(): string {
    const lines: string[] = [];
    for (const [key, entry] of this.metrics) {
      const name = key.split("{")[0].replace(/\./g, "_");
      const labelStr = Object.entries(entry.labels)
        .map(([k, v]) => `${k}="${v}"`)
        .join(",");
      const suffix = labelStr ? `{${labelStr}}` : "";
      lines.push(`# TYPE ${name} ${entry.type}`);
      lines.push(`${name}${suffix} ${entry.value}`);
    }
    return lines.join("\n") + "\n";
  }

  private makeKey(name: string, labels: Record<string, string>): string {
    const sorted = Object.keys(labels).sort();
    if (sorted.length === 0) return name;
    const labelStr = sorted.map((k) => `${k}="${labels[k]}"`).join(",");
    return `${name}{${labelStr}}`;
  }
}
