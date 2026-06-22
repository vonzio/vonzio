import { describe, it, expect, vi } from "vitest";
import type { FastifyRequest, FastifyReply } from "fastify";
import { authorizeTenantAccess, adminOnlyHook, adminReadHook, isOwnerOrAdmin } from "./user-auth.js";

function req(user: { id: string; role: string } | undefined, orgId?: string): FastifyRequest {
  return { user, orgContext: orgId ? { org_id: orgId } : undefined } as unknown as FastifyRequest;
}

function reply(): FastifyReply & { _code?: number } {
  const r: Record<string, unknown> = {};
  r.code = vi.fn((c: number) => { r._code = c; return r; });
  r.send = vi.fn(() => r);
  return r as unknown as FastifyReply & { _code?: number };
}

describe("authorizeTenantAccess", () => {
  const owner = { id: "u1", role: "user" };
  const other = { id: "u2", role: "user" };
  const admin = { id: "a1", role: "admin" };

  describe("OSS (no org context) → owner-or-admin", () => {
    it("allows the owner", () => {
      expect(authorizeTenantAccess(req(owner), { user_id: "u1", org_id: null })).toBe(true);
    });
    it("denies a non-owner", () => {
      expect(authorizeTenantAccess(req(other), { user_id: "u1", org_id: null })).toBe(false);
    });
    it("allows admin (instance owner)", () => {
      expect(authorizeTenantAccess(req(admin), { user_id: "u1", org_id: null })).toBe(true);
    });
  });

  describe("SaaS (org context) → strict org match, no role bypass", () => {
    it("allows when resource org matches the active org", () => {
      expect(authorizeTenantAccess(req(other, "orgA"), { user_id: "u1", org_id: "orgA" })).toBe(true);
    });
    it("denies cross-org even for the resource owner", () => {
      expect(authorizeTenantAccess(req(owner, "orgB"), { user_id: "u1", org_id: "orgA" })).toBe(false);
    });
    it("denies cross-org even for an admin (no platform bypass inside an org)", () => {
      expect(authorizeTenantAccess(req(admin, "orgB"), { user_id: "u1", org_id: "orgA" })).toBe(false);
    });
    it("fails closed when the resource has no org", () => {
      expect(authorizeTenantAccess(req(admin, "orgA"), { user_id: "u1", org_id: null })).toBe(false);
    });
  });

  it("denies when unauthenticated", () => {
    expect(authorizeTenantAccess(req(undefined), { user_id: "u1", org_id: null })).toBe(false);
  });
});

describe("adminOnlyHook — only the real admin role passes", () => {
  it("passes admin", async () => {
    const r = reply();
    await adminOnlyHook(req({ id: "a1", role: "admin" }), r);
    expect(r.code).not.toHaveBeenCalled();
  });

  it("REGRESSION: rejects api_token role (privilege-escalation backdoor)", async () => {
    const r = reply();
    await adminOnlyHook(req({ id: "u1", role: "api_token" }), r);
    expect(r._code).toBe(403);
  });

  it("rejects ordinary users and unauthenticated", async () => {
    const r1 = reply();
    await adminOnlyHook(req({ id: "u1", role: "user" }), r1);
    expect(r1._code).toBe(403);
    const r2 = reply();
    await adminOnlyHook(req(undefined), r2);
    expect(r2._code).toBe(403);
  });
});

describe("adminReadHook (real-role gate for token callers)", () => {
  it("passes a session admin without resolving", async () => {
    const resolve = vi.fn();
    const r = reply();
    await adminReadHook(resolve)(req({ id: "a1", role: "admin" }), r);
    expect(r.code).not.toHaveBeenCalled();
    expect(resolve).not.toHaveBeenCalled();
  });

  it("admits an api_token whose owner is a real admin", async () => {
    const resolve = vi.fn(async () => "admin");
    const r = reply();
    await adminReadHook(resolve)(req({ id: "u1", role: "api_token" }), r);
    expect(resolve).toHaveBeenCalledWith("u1");
    expect(r.code).not.toHaveBeenCalled();
  });

  it("rejects an api_token whose owner is NOT admin (no privilege widening)", async () => {
    const resolve = vi.fn(async () => "user");
    const r = reply();
    await adminReadHook(resolve)(req({ id: "u2", role: "api_token" }), r);
    expect(r._code).toBe(403);
  });

  it("rejects when the resolver throws (fail closed)", async () => {
    const resolve = vi.fn(async () => { throw new Error("db down"); });
    const r = reply();
    await adminReadHook(resolve)(req({ id: "u1", role: "api_token" }), r);
    expect(r._code).toBe(403);
  });

  it("401s an unauthenticated request", async () => {
    const r = reply();
    await adminReadHook(vi.fn())(req(undefined), r);
    expect(r._code).toBe(401);
  });

  it("rejects an ordinary session user", async () => {
    const r = reply();
    await adminReadHook(vi.fn())(req({ id: "u1", role: "user" }), r);
    expect(r._code).toBe(403);
  });
});

describe("isOwnerOrAdmin", () => {
  const u = (id: string, role: string) => ({ id, role, email: "", name: "" });
  it("treats null resource owner as shared", () => {
    expect(isOwnerOrAdmin(u("u1", "user"), null)).toBe(true);
  });
  it("matches owner and admin, rejects others", () => {
    expect(isOwnerOrAdmin(u("u1", "user"), "u1")).toBe(true);
    expect(isOwnerOrAdmin(u("a1", "admin"), "u1")).toBe(true);
    expect(isOwnerOrAdmin(u("u2", "user"), "u1")).toBe(false);
  });
});
