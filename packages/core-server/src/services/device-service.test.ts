import { describe, it, expect, beforeEach } from "vitest";
import {
  DeviceService,
  normalizeUserCode,
  type DeviceCodeRecord,
  type DeviceCodeStore,
} from "./device-service.js";

/** In-memory store so the state machine is tested without a database. */
class MemStore implements DeviceCodeStore {
  rows = new Map<string, DeviceCodeRecord>();
  async create(rec: DeviceCodeRecord) { this.rows.set(rec.id, { ...rec }); }
  async findByUserCode(uc: string) { return [...this.rows.values()].find((r) => r.user_code === uc) ?? null; }
  async findByDeviceCode(dc: string) { return [...this.rows.values()].find((r) => r.device_code === dc) ?? null; }
  async update(id: string, patch: Partial<DeviceCodeRecord>) {
    const r = this.rows.get(id); if (r) this.rows.set(id, { ...r, ...patch });
  }
  async markConsumed(id: string) {
    const r = this.rows.get(id);
    if (r && r.status === "approved") { this.rows.set(id, { ...r, status: "consumed" }); return true; }
    return false;
  }
}

describe("DeviceService", () => {
  let store: MemStore;
  let clock: number;
  let minted: number;
  let svc: DeviceService;

  beforeEach(() => {
    store = new MemStore();
    clock = 1_000_000;
    minted = 0;
    svc = new DeviceService(
      store,
      async (userId, name) => { minted++; return { token: `rc_${userId}_${name}` }; },
      { baseUrl: "https://app.vonz.io", expiresInSec: 600, intervalSec: 5, now: () => clock },
    );
  });

  it("requestCode returns RFC fields + creates a pending row", async () => {
    const r = await svc.requestCode("vonzio CLI");
    expect(r.device_code).toHaveLength(64);
    expect(r.user_code).toMatch(/^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
    expect(r.verification_uri).toBe("https://app.vonz.io/device");
    expect(r.verification_uri_complete).toBe(`https://app.vonz.io/device?user_code=${r.user_code}`);
    expect(r.expires_in).toBe(600);
    expect(r.interval).toBe(5);
    const row = [...store.rows.values()][0];
    expect(row.status).toBe("pending");
    expect(row.user_code).toBe(normalizeUserCode(r.user_code)); // stored without dash
  });

  it("approve: unknown code → not_found", async () => {
    expect(await svc.approve("ZZZZ-ZZZZ", "u1", null)).toEqual({ ok: false, error: "not_found" });
  });

  it("approve: pending → approved (accepts dashed/undashed/lowercase)", async () => {
    const r = await svc.requestCode();
    const res = await svc.approve(r.user_code.toLowerCase(), "u1", null);
    expect(res).toEqual({ ok: true, clientName: null });
    expect([...store.rows.values()][0]).toMatchObject({ status: "approved", user_id: "u1" });
  });

  it("approve: already-approved → already_used", async () => {
    const r = await svc.requestCode();
    await svc.approve(r.user_code, "u1", null);
    expect(await svc.approve(r.user_code, "u1", null)).toEqual({ ok: false, error: "already_used" });
  });

  it("approve: expired → expired", async () => {
    const r = await svc.requestCode();
    clock += 601_000; // past expiry
    expect(await svc.approve(r.user_code, "u1", null)).toEqual({ ok: false, error: "expired" });
  });

  it("poll: unknown device_code → access_denied", async () => {
    expect(await svc.poll("nope")).toEqual({ status: "error", error: "access_denied" });
  });

  it("poll: pending → authorization_pending", async () => {
    const r = await svc.requestCode();
    expect(await svc.poll(r.device_code)).toEqual({ status: "error", error: "authorization_pending" });
  });

  it("poll: too-fast second poll → slow_down", async () => {
    const r = await svc.requestCode();
    await svc.poll(r.device_code);            // records last_polled
    expect(await svc.poll(r.device_code)).toEqual({ status: "error", error: "slow_down" }); // same clock
  });

  it("poll: approved → mints token once, then single-use access_denied", async () => {
    const r = await svc.requestCode();
    await svc.approve(r.user_code, "u1", null);
    const ok = await svc.poll(r.device_code);
    expect(ok).toEqual({ status: "approved", accessToken: "rc_u1_vonzio CLI" });
    expect(minted).toBe(1);
    expect([...store.rows.values()][0].status).toBe("consumed");
    clock += 10_000; // avoid slow_down on the re-poll
    expect(await svc.poll(r.device_code)).toEqual({ status: "error", error: "access_denied" });
    expect(minted).toBe(1); // not re-minted
  });

  it("poll: concurrent polls of an approved code mint only one token", async () => {
    const r = await svc.requestCode();
    await svc.approve(r.user_code, "u1", null);
    const [a, b] = await Promise.all([svc.poll(r.device_code), svc.poll(r.device_code)]);
    const approvals = [a, b].filter((x) => x.status === "approved");
    expect(approvals).toHaveLength(1);
    expect(minted).toBe(1);
  });

  it("poll: expired → expired_token", async () => {
    const r = await svc.requestCode();
    await svc.approve(r.user_code, "u1", null);
    clock += 601_000;
    expect(await svc.poll(r.device_code)).toEqual({ status: "error", error: "expired_token" });
    expect(minted).toBe(0);
  });
});
