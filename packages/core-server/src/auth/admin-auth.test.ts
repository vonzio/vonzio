import { describe, it, expect, beforeAll } from "vitest";
import Fastify from "fastify";
import bcrypt from "bcrypt";
import { adminAuthPlugin } from "./admin-auth.js";

describe("adminAuthPlugin", () => {
  const ADMIN_PASSWORD = "supersecret";
  let passwordHash: string;

  beforeAll(async () => {
    passwordHash = await bcrypt.hash(ADMIN_PASSWORD, 10);
  });

  function buildApp() {
    const app = Fastify({ logger: false });
    app.register(adminAuthPlugin, { passwordHash });
    app.get("/admin/test", async () => ({ ok: true }));
    return app;
  }

  it("passes with correct admin password", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: `Bearer ${ADMIN_PASSWORD}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it("returns 401 for wrong password", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/admin/test",
      headers: { authorization: "Bearer wrongpassword" },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("returns 401 for missing header", async () => {
    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/admin/test",
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
