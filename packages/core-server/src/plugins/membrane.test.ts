import { describe, it, expect, vi } from "vitest";
import { assembleCore, throwingSurface, type CapabilityViolation } from "./membrane.js";
import { CapabilityViolationError, type PluginCapability, type PluginCore } from "@vonzio/plugin-api";

// A stand-in "full" core. Only the surfaces touched by the tests need to be
// real; the rest are sentinel objects so we can assert identity passthrough.
function makeFullCore(): PluginCore {
  const calls: string[] = [];
  const rec = (name: string) => (...args: unknown[]) => {
    calls.push(`${name}:${JSON.stringify(args)}`);
    return { name, args };
  };
  const core = {
    db: { __db: true },
    encryption: { encrypt: rec("encrypt"), decrypt: rec("decrypt") },
    integrations: {
      get: rec("get"),
      getByUserAndType: rec("getByUserAndType"),
      listByType: rec("listByType"),
      listByUserAndType: rec("listByUserAndType"),
      findByTypeAndExternalId: rec("findByTypeAndExternalId"),
      listByTypeAndExternalId: rec("listByTypeAndExternalId"),
      backfillExternalId: rec("backfillExternalId"),
      create: rec("create"),
      update: rec("update"),
      delete: rec("delete"),
    },
    profiles: { list: rec("p.list"), get: rec("p.get") },
    profileResolver: { getResolved: rec("pr.getResolved") },
    workspaces: { get: rec("w.get"), list: rec("w.list"), update: rec("w.update") },
    authHook: rec("authHook"),
    sessionPresence: { register: rec("sp.register") },
    tasks: { submit: rec("t.submit") },
    sessionLifecycle: {
      register: rec("sl.register"),
      extendExpiry: rec("sl.extend"),
      setStatus: rec("sl.setStatus"),
      getConnectedSessionIds: rec("sl.connected"),
    },
    orchestrator: { wakeWorkspaceContainer: rec("o.wake") },
    eventLog: { append: rec("el.append"), read: rec("el.read") },
    connectionManager: { sendToSession: rec("cm.send") },
    imageRewriter: { forSession: rec("ir.forSession") },
    modelList: { listForProfile: rec("ml.list") },
  } as unknown as PluginCore;
  return core;
}

const grant = (...caps: PluginCapability[]) => new Set<PluginCapability>(caps);

describe("assembleCore — property-level gating", () => {
  it("includes a granted property surface and throws on an undeclared one", () => {
    const violations: CapabilityViolation[] = [];
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("storage.kv"), // note: storage.kv is a ctx surface, not core — so core is empty
      onViolation: (v) => violations.push(v),
    });
    expect(() => (core as unknown as { db: unknown }).db).toThrow(CapabilityViolationError);
    expect(violations.at(-1)).toMatchObject({ plugin: "p", key: "db" });
  });

  it("db is included when db.access granted (loader places the handle)", () => {
    const full = makeFullCore();
    const { core } = assembleCore(full, { pluginName: "p", granted: grant("db.access") });
    expect((core as unknown as { db: unknown }).db).toBe(full.db);
  });
});

describe("assembleCore — §7 legibility traps", () => {
  it("has() reports false for undeclared, ownKeys shows only declared", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("tasks.submit", "models.list"),
    });
    expect("db" in core).toBe(false);
    expect("tasks" in core).toBe(true);
    expect(Reflect.ownKeys(core).sort()).toEqual(["modelList", "tasks"]);
    expect(Object.keys({ ...core }).sort()).toEqual(["modelList", "tasks"]);
  });

  it("is frozen: set / defineProperty / setPrototypeOf throw", () => {
    const { core } = assembleCore(makeFullCore(), { pluginName: "p", granted: grant("tasks.submit") });
    expect(() => {
      (core as unknown as Record<string, unknown>).injected = 1;
    }).toThrow(CapabilityViolationError);
    expect(() => Object.defineProperty(core, "x", { value: 1 })).toThrow();
    expect(() => Object.setPrototypeOf(core, {})).toThrow();
  });

  it("prototype is null — no constructor recon", () => {
    const { core } = assembleCore(makeFullCore(), { pluginName: "p", granted: grant("tasks.submit") });
    expect(Object.getPrototypeOf(core)).toBeNull();
  });

  it("revoke() makes captured references throw", () => {
    const { core, revoke } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("tasks.submit"),
    });
    revoke();
    expect(() => (core as unknown as { tasks: unknown }).tasks).toThrow();
  });
});

describe("assembleCore — method-level splits", () => {
  it("encryption: only granted method works, the other throws CapabilityViolationError", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("encryption.encrypt"),
    });
    expect(() => core.encryption.encrypt("x")).not.toThrow();
    expect(() => core.encryption.decrypt("x")).toThrow(CapabilityViolationError);
  });

  it("workspaces read vs write", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("workspaces.read"),
    });
    expect(() => core.workspaces.get("s")).not.toThrow();
    expect(() => core.workspaces.update("s", {})).toThrow(CapabilityViolationError);
  });

  it("sessions.* split per method", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("sessions.register"),
    });
    expect(() => core.sessionLifecycle.register("s", "u", "pr")).not.toThrow();
    expect(() => core.sessionLifecycle.setStatus("s", "active")).toThrow(CapabilityViolationError);
  });
});

describe("assembleCore — integrations argument-level masking", () => {
  it("masked-only clamps opts.decrypt to false", () => {
    const full = makeFullCore();
    const spy = vi.spyOn(full.integrations, "get");
    const { core } = assembleCore(full, {
      pluginName: "p",
      granted: grant("integrations.read.masked"),
    });
    core.integrations.get("id", { decrypt: true });
    expect(spy).toHaveBeenCalledWith("id", { decrypt: false });
  });

  it("decrypted allows opts.decrypt:true to pass through", () => {
    const full = makeFullCore();
    const spy = vi.spyOn(full.integrations, "get");
    const { core } = assembleCore(full, {
      pluginName: "p",
      granted: grant("integrations.read.decrypted"),
    });
    core.integrations.get("id", { decrypt: true });
    expect(spy).toHaveBeenCalledWith("id", { decrypt: true });
  });

  it("write methods require integrations.write", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("integrations.read.masked"),
    });
    expect(() => core.integrations.create("u", "t", {})).toThrow(CapabilityViolationError);
  });

  it("read-only plugin cannot reach a read method? (it can — masked grants reads)", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("integrations.write"),
    });
    // write-only: read methods are stubs
    expect(() => core.integrations.get("id")).toThrow(CapabilityViolationError);
    expect(() => core.integrations.create("u", "t", {})).not.toThrow();
  });
});

describe("assembleCore — spread of leaf surfaces (built-in compat)", () => {
  it("{...core.profiles, ...core.profileResolver} keeps all methods", () => {
    const { core } = assembleCore(makeFullCore(), {
      pluginName: "p",
      granted: grant("profiles.read", "profiles.resolve"),
    });
    const merged = { ...core.profiles, ...core.profileResolver } as Record<string, unknown>;
    expect(typeof merged.list).toBe("function");
    expect(typeof merged.get).toBe("function");
    expect(typeof merged.getResolved).toBe("function");
  });
});

describe("throwingSurface", () => {
  it("throws CapabilityViolationError on any property access", () => {
    const violations: CapabilityViolation[] = [];
    const stub = throwingSurface<{ fetch: () => void }>(
      "p",
      "http.outbound",
      "http",
      (v) => violations.push(v),
    );
    expect(() => stub.fetch()).toThrow(CapabilityViolationError);
    expect(violations.at(-1)).toMatchObject({ plugin: "p", capability: "http.outbound", key: "http.fetch" });
  });
});
