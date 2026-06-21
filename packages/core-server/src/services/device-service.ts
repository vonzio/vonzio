import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { and, eq } from "drizzle-orm";
import type { DrizzleDB } from "../db/index.js";
import { schema } from "../db/index.js";

/**
 * RFC 8628 device-authorization flow for the `vonzio` CLI.
 *
 * Storage is behind a small interface so the state machine is unit-testable
 * without a database. Token minting is injected (the route wires it to
 * `createApiToken`) so the issued token is a normal, validator-compatible
 * api_token.
 */

export type DeviceCodeStatus = "pending" | "approved" | "consumed" | "denied";

export interface DeviceCodeRecord {
  id: string;
  device_code: string;
  user_code: string; // stored normalized (no dashes, uppercase)
  status: DeviceCodeStatus;
  user_id: string | null;
  org_id: string | null;
  client_name: string | null;
  expires_at: string;
  created_at: string;
  last_polled_at: string | null;
}

export interface DeviceCodeStore {
  create(rec: DeviceCodeRecord): Promise<void>;
  findByUserCode(userCode: string): Promise<DeviceCodeRecord | null>;
  findByDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null>;
  update(id: string, patch: Partial<DeviceCodeRecord>): Promise<void>;
  /** Atomically flip approved→consumed. Returns true only for the caller that
   *  won the transition — guards against two concurrent polls double-minting. */
  markConsumed(id: string): Promise<boolean>;
}

/** Unambiguous user_code alphabet — no vowels (no accidental words) and no
 *  0/O/1/I/L lookalikes. */
const USER_CODE_ALPHABET = "BCDFGHJKMNPQRSTVWXYZ23456789";

export function normalizeUserCode(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function genUserCode(): string {
  const bytes = randomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) out += USER_CODE_ALPHABET[bytes[i] % USER_CODE_ALPHABET.length];
  return out; // normalized; formatted for display by requestCode
}

export interface DeviceCodeRequest {
  device_code: string;
  user_code: string; // display form "XXXX-XXXX"
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type PollResult =
  | { status: "approved"; accessToken: string }
  | { status: "error"; error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" };

export type ApproveResult =
  | { ok: true; clientName: string | null }
  | { ok: false; error: "not_found" | "expired" | "already_used" };

export class DeviceService {
  constructor(
    private store: DeviceCodeStore,
    private mintToken: (userId: string, name: string) => Promise<{ token: string }>,
    private opts: {
      baseUrl: string;
      expiresInSec?: number;
      intervalSec?: number;
      now?: () => number; // injectable clock for tests
    },
  ) {}

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  async requestCode(clientName?: string): Promise<DeviceCodeRequest> {
    const expiresInSec = this.opts.expiresInSec ?? 600;
    const interval = this.opts.intervalSec ?? 5;
    const deviceCode = randomBytes(32).toString("hex");
    const userCode = genUserCode();
    const nowMs = this.now();
    await this.store.create({
      id: `dev_${nanoid()}`,
      device_code: deviceCode,
      user_code: userCode,
      status: "pending",
      user_id: null,
      org_id: null,
      client_name: clientName ?? null,
      expires_at: new Date(nowMs + expiresInSec * 1000).toISOString(),
      created_at: new Date(nowMs).toISOString(),
      last_polled_at: null,
    });
    const base = this.opts.baseUrl.replace(/\/$/, "");
    const display = `${userCode.slice(0, 4)}-${userCode.slice(4)}`;
    return {
      device_code: deviceCode,
      user_code: display,
      verification_uri: `${base}/device`,
      verification_uri_complete: `${base}/device?user_code=${display}`,
      expires_in: expiresInSec,
      interval,
    };
  }

  /** Called by the logged-in user (session-authed) to approve a user_code. */
  async approve(userCodeRaw: string, userId: string, orgId: string | null): Promise<ApproveResult> {
    const rec = await this.store.findByUserCode(normalizeUserCode(userCodeRaw));
    if (!rec) return { ok: false, error: "not_found" };
    if (this.isExpired(rec)) return { ok: false, error: "expired" };
    if (rec.status !== "pending") return { ok: false, error: "already_used" };
    await this.store.update(rec.id, { status: "approved", user_id: userId, org_id: orgId });
    return { ok: true, clientName: rec.client_name };
  }

  /** Called by the CLI (unauthenticated) to poll for the token. */
  async poll(deviceCode: string): Promise<PollResult> {
    const rec = await this.store.findByDeviceCode(deviceCode);
    if (!rec) return { status: "error", error: "access_denied" };
    if (this.isExpired(rec)) return { status: "error", error: "expired_token" };

    // slow_down: enforce the poll interval. Always record the poll time.
    const intervalMs = (this.opts.intervalSec ?? 5) * 1000;
    const nowMs = this.now();
    if (rec.last_polled_at && nowMs - Date.parse(rec.last_polled_at) < intervalMs) {
      await this.store.update(rec.id, { last_polled_at: new Date(nowMs).toISOString() });
      return { status: "error", error: "slow_down" };
    }
    await this.store.update(rec.id, { last_polled_at: new Date(nowMs).toISOString() });

    switch (rec.status) {
      case "pending":
        return { status: "error", error: "authorization_pending" };
      case "denied":
      case "consumed":
        return { status: "error", error: "access_denied" };
      case "approved": {
        if (!rec.user_id) return { status: "error", error: "access_denied" };
        // Consume FIRST (atomic approved→consumed); only the winner mints, so a
        // racing concurrent poll can't produce a second token.
        const won = await this.store.markConsumed(rec.id);
        if (!won) return { status: "error", error: "access_denied" };
        const { token } = await this.mintToken(rec.user_id, rec.client_name || "vonzio CLI");
        return { status: "approved", accessToken: token };
      }
    }
  }

  private isExpired(rec: DeviceCodeRecord): boolean {
    return this.now() > Date.parse(rec.expires_at);
  }
}

/** Drizzle-backed store. */
export class DrizzleDeviceCodeStore implements DeviceCodeStore {
  constructor(private db: DrizzleDB) {}

  async create(rec: DeviceCodeRecord): Promise<void> {
    await this.db.insert(schema.deviceCodes).values(rec);
  }

  async findByUserCode(userCode: string): Promise<DeviceCodeRecord | null> {
    const rows = await this.db.select().from(schema.deviceCodes).where(eq(schema.deviceCodes.user_code, userCode));
    return (rows[0] as DeviceCodeRecord) ?? null;
  }

  async findByDeviceCode(deviceCode: string): Promise<DeviceCodeRecord | null> {
    const rows = await this.db.select().from(schema.deviceCodes).where(eq(schema.deviceCodes.device_code, deviceCode));
    return (rows[0] as DeviceCodeRecord) ?? null;
  }

  async update(id: string, patch: Partial<DeviceCodeRecord>): Promise<void> {
    await this.db.update(schema.deviceCodes).set(patch).where(eq(schema.deviceCodes.id, id));
  }

  async markConsumed(id: string): Promise<boolean> {
    const rows = await this.db
      .update(schema.deviceCodes)
      .set({ status: "consumed" })
      .where(and(eq(schema.deviceCodes.id, id), eq(schema.deviceCodes.status, "approved")))
      .returning({ id: schema.deviceCodes.id });
    return rows.length > 0;
  }
}
