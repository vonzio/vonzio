import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { sql } from "drizzle-orm";
import { MetricsCollector } from "./collector.js";
import { schema, type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";

describe("MetricsCollector", () => {
  it("increments counters", () => {
    const collector = new MetricsCollector();
    collector.counter("task.submitted");
    collector.counter("task.submitted");
    collector.counter("task.submitted", {}, 3);

    expect(collector.get("task.submitted")).toBe(5);
  });

  it("sets gauges", () => {
    const collector = new MetricsCollector();
    collector.gauge("pool.depth", 3);
    expect(collector.get("pool.depth")).toBe(3);

    collector.gauge("pool.depth", 5);
    expect(collector.get("pool.depth")).toBe(5);
  });

  it("records histogram values", () => {
    const collector = new MetricsCollector();
    collector.histogram("task.duration_seconds", 1.5);
    collector.histogram("task.duration_seconds", 2.3);

    expect(collector.get("task.duration_seconds")).toBe(2.3);
  });

  it("tracks separate metrics per label set", () => {
    const collector = new MetricsCollector();
    collector.counter("task.submitted", { mode: "batch" });
    collector.counter("task.submitted", { mode: "pooled" });
    collector.counter("task.submitted", { mode: "batch" });

    expect(collector.get("task.submitted", { mode: "batch" })).toBe(2);
    expect(collector.get("task.submitted", { mode: "pooled" })).toBe(1);
  });

  it("getAll returns all metrics", () => {
    const collector = new MetricsCollector();
    collector.counter("a", {}, 10);
    collector.gauge("b", 20);
    collector.histogram("c", 30);

    const all = collector.getAll();
    expect(all).toHaveLength(3);
    expect(all.map((m) => m.name).sort()).toEqual(["a", "b", "c"]);
  });

  it("flushes metrics to database", async () => {
    const handle = await createTestDB();

    const collector = new MetricsCollector(handle.db);
    collector.counter("task.submitted", {}, 5);
    collector.gauge("pool.depth", 3, { mode: "pooled" });

    await collector.flush();

    const rows = await handle.db.select().from(schema.metrics);
    expect(rows.length).toBe(2);
    expect(rows.find((r) => r.name === "task.submitted")?.value).toBe(5);
    expect(rows.find((r) => r.name === "pool.depth")?.value).toBe(3);

    await handle.close();
  });

  it("generates Prometheus text format", () => {
    const collector = new MetricsCollector();
    collector.counter("task_submitted", {});
    collector.gauge("pool_depth", 3, { mode: "pooled" });

    const text = collector.toPrometheus();
    expect(text).toContain("# TYPE task_submitted counter");
    expect(text).toContain("task_submitted 1");
    expect(text).toContain("# TYPE pool_depth gauge");
    expect(text).toContain('pool_depth{mode="pooled"} 3');
  });

  it("returns undefined for non-existent metric", () => {
    const collector = new MetricsCollector();
    expect(collector.get("nonexistent")).toBeUndefined();
  });
});
