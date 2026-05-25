import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { tellerConnectRoutes, canonicalize } from "./teller-connect.js";
import type { IntegrationService, Integration, TellerConfig } from "../services/integration-service.js";
import type { Config } from "../config.js";

/** In-memory IntegrationService stub. Only implements the methods the
 *  teller callback exercises, so the test stays decoupled from Postgres. */
function makeStubIntegrationService() {
  let counter = 0;
  const rows: Integration[] = [];
  const svc = {
    async create(userId: string, type: string, config: Record<string, unknown>): Promise<Integration> {
      const id = `int_test_${++counter}`;
      const now = new Date().toISOString();
      const row: Integration = {
        id, user_id: userId, type,
        config: { ...config },
        enabled: true, is_default: false,
        scope: "all", profile_ids: [],
        created_at: now, updated_at: now,
      };
      rows.push(row);
      return row;
    },
    async listByUserAndType(userId: string, type: string): Promise<Integration[]> {
      return rows.filter((r) => r.user_id === userId && r.type === type);
    },
    async delete(id: string): Promise<boolean> {
      const i = rows.findIndex((r) => r.id === id);
      if (i < 0) return false;
      rows.splice(i, 1);
      return true;
    },
  } as unknown as IntegrationService;
  return { svc, rows };
}

function makeApp(config: Partial<Config>, integrationService: IntegrationService): FastifyInstance {
  const app = Fastify({ logger: false });
  // Stub auth — every request carries a fixed test user.
  app.addHook("preHandler", async (req) => {
    (req as { user?: { id: string } }).user = { id: "user_test_1" };
  });
  app.register(tellerConnectRoutes, {
    config: {
      TELLER_API_BASE: "https://api.teller.io",
      TELLER_APP_ID: "app_test",
      TELLER_CERT_PATH: "/tmp/cert.pem",
      TELLER_KEY_PATH: "/tmp/key.pem",
      ...config,
    } as Config,
    integrationService,
  });
  return app;
}

describe("teller-connect routes", () => {
  let app: FastifyInstance;
  let stub: ReturnType<typeof makeStubIntegrationService>;

  beforeEach(() => {
    stub = makeStubIntegrationService();
    app = makeApp({}, stub.svc);
  });

  it("GET /v1/integrations/teller/config reports enabled when configured", async () => {
    const res = await app.inject({ method: "GET", url: "/v1/integrations/teller/config" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ enabled: true, application_id: "app_test" });
  });

  it("GET /v1/integrations/teller/config reports disabled when cert path missing", async () => {
    const app2 = makeApp({ TELLER_CERT_PATH: undefined }, stub.svc);
    const res = await app2.inject({ method: "GET", url: "/v1/integrations/teller/config" });
    expect(res.json()).toEqual({ enabled: false, application_id: "app_test" });
  });

  it("POST /v1/integrations/teller/callback persists an enrollment", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/v1/integrations/teller/callback",
      payload: {
        accessToken: "token_abc",
        enrollment: { id: "enr_1", institution: { id: "pnc", name: "PNC" } },
        user: { id: "usr_x" },
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ enrollment_id: "enr_1", institution_name: "PNC" });
    expect(body.id).toMatch(/^int_test_/);
    expect(stub.rows).toHaveLength(1);
    const stored = stub.rows[0].config as unknown as TellerConfig;
    expect(stored.access_token).toBe("token_abc");
    expect(stored.enrollment_id).toBe("enr_1");
    expect(stored.institution_name).toBe("PNC");
    expect(stored.institution_id).toBe("pnc");
    expect(stored.teller_user_id).toBe("usr_x");
  });

  it("rejects malformed payloads with 400", async () => {
    const res = await app.inject({
      method: "POST", url: "/v1/integrations/teller/callback",
      payload: { accessToken: "token_x" }, // missing enrollment
    });
    expect(res.statusCode).toBe(400);
  });

  it("dedupes by replacing an existing row with the same enrollment_id", async () => {
    const payload1 = {
      accessToken: "token_v1",
      enrollment: { id: "enr_same", institution: { id: "pnc", name: "PNC" } },
    };
    const r1 = await app.inject({ method: "POST", url: "/v1/integrations/teller/callback", payload: payload1 });
    expect(r1.statusCode).toBe(200);
    const firstId = r1.json().id;
    expect(stub.rows).toHaveLength(1);

    // Re-run Connect (e.g. user re-granted) — same enrollment_id, fresh token.
    const r2 = await app.inject({
      method: "POST", url: "/v1/integrations/teller/callback",
      payload: { ...payload1, accessToken: "token_v2" },
    });
    expect(r2.statusCode).toBe(200);
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0].id).not.toBe(firstId);
    expect((stub.rows[0].config as unknown as TellerConfig).access_token).toBe("token_v2");
  });

  it("keeps separate rows for different enrollment_ids (multi-bank)", async () => {
    await app.inject({
      method: "POST", url: "/v1/integrations/teller/callback",
      payload: { accessToken: "tok_a", enrollment: { id: "enr_a", institution: { name: "PNC" } } },
    });
    await app.inject({
      method: "POST", url: "/v1/integrations/teller/callback",
      payload: { accessToken: "tok_b", enrollment: { id: "enr_b", institution: { name: "Chase" } } },
    });
    expect(stub.rows).toHaveLength(2);
    const enrollmentIds = stub.rows.map((r) => (r.config as unknown as TellerConfig).enrollment_id).sort();
    expect(enrollmentIds).toEqual(["enr_a", "enr_b"]);
  });
});

describe("canonicalize", () => {
  it("sorts top-level keys", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it("sorts nested object keys (regression for shallow-sort bug)", () => {
    const a = canonicalize({ outer: { y: 1, x: 2 } });
    const b = canonicalize({ outer: { x: 2, y: 1 } });
    expect(a).toBe(b);
    expect(a).toBe('{"outer":{"x":2,"y":1}}');
  });

  it("preserves array order (semantically meaningful)", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
  });

  it("recurses into arrays of objects", () => {
    const a = canonicalize({ items: [{ b: 1, a: 2 }, { d: 3, c: 4 }] });
    expect(a).toBe('{"items":[{"a":2,"b":1},{"c":4,"d":3}]}');
  });

  it("handles primitives and null", () => {
    expect(canonicalize("x")).toBe('"x"');
    expect(canonicalize(42)).toBe("42");
    expect(canonicalize(null)).toBe("null");
    expect(canonicalize(true)).toBe("true");
  });
});
