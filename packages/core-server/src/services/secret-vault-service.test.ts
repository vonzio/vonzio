import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { SecretVaultService } from "./secret-vault-service.js";

/**
 * Covers the per-agent scoping behaviour added by feature #17:
 *   - shape validation of scope + profile_ids (create / update),
 *   - getDecryptedForProfile resolution (scope='all' vs scope='agents'),
 *   - cross-user isolation.
 * The CRUD plumbing (encryption, redaction, name regex, ownership on delete)
 * is hit in passing — the SecretVaultService didn't have a test file before
 * this feature, so we add the baseline at the same time.
 */

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

describe("SecretVaultService", () => {
  let handle: DB;
  let svc: SecretVaultService;
  const USER = "user_alice";

  beforeEach(async () => {
    handle = await createTestDB();
    svc = new SecretVaultService(handle.db, ENCRYPTION_KEY);
  });

  afterEach(async () => {
    await handle.close();
  });

  it("creates a secret with scope='all' by default", async () => {
    const s = await svc.create(USER, "API_TOKEN", "secret-value");
    expect(s.name).toBe("API_TOKEN");
    expect(s.scope).toBe("all");
    expect(s.profile_ids).toEqual([]);
    expect(s.value).toBe("••••••••"); // mapRow redacts
  });

  it("creates a secret scoped to specific agent profiles", async () => {
    const s = await svc.create(USER, "DB_URL", "postgres://...", {
      scope: "agents",
      profile_ids: ["prof_1", "prof_2"],
    });
    expect(s.scope).toBe("agents");
    expect(s.profile_ids).toEqual(["prof_1", "prof_2"]);
  });

  it("rejects scope='agents' with empty profile_ids", async () => {
    await expect(
      svc.create(USER, "FOO", "bar", { scope: "agents", profile_ids: [] }),
    ).rejects.toThrow(/profile_ids/i);
  });

  it("rejects an unknown scope value", async () => {
    await expect(
      svc.create(USER, "FOO", "bar", { scope: "world" as never }),
    ).rejects.toThrow(/scope/i);
  });

  it("deduplicates profile_ids on create", async () => {
    const s = await svc.create(USER, "FOO", "bar", {
      scope: "agents",
      profile_ids: ["prof_1", "prof_1", "prof_2"],
    });
    expect(s.profile_ids).toEqual(["prof_1", "prof_2"]);
  });

  it("rejects invalid secret names", async () => {
    await expect(svc.create(USER, "lower", "v")).rejects.toThrow();
    await expect(svc.create(USER, "1FIRST", "v")).rejects.toThrow();
    await expect(svc.create(USER, "WITH-DASH", "v")).rejects.toThrow();
  });

  it("updates scope from 'all' -> 'agents' and back, clearing profile_ids on the way back", async () => {
    const s = await svc.create(USER, "FOO", "bar");

    const after1 = await svc.update(s.id, USER, {
      scope: "agents",
      profile_ids: ["prof_1"],
    });
    expect(after1?.scope).toBe("agents");
    expect(after1?.profile_ids).toEqual(["prof_1"]);

    const after2 = await svc.update(s.id, USER, { scope: "all" });
    expect(after2?.scope).toBe("all");
    // normalizeScope clears the list whenever scope='all'
    expect(after2?.profile_ids).toEqual([]);
  });

  it("update of just profile_ids preserves scope='agents'", async () => {
    const s = await svc.create(USER, "FOO", "bar", {
      scope: "agents",
      profile_ids: ["prof_1"],
    });
    const after = await svc.update(s.id, USER, { profile_ids: ["prof_2", "prof_3"] });
    expect(after?.scope).toBe("agents");
    expect(after?.profile_ids).toEqual(["prof_2", "prof_3"]);
  });

  it("getDecryptedForProfile injects scope='all' secrets into any profile", async () => {
    await svc.create(USER, "GLOBAL", "global-value");
    const env = await svc.getDecryptedForProfile(USER, "prof_anything");
    expect(env.GLOBAL).toBe("global-value");
  });

  it("getDecryptedForProfile includes scope='agents' secrets only for listed profiles", async () => {
    await svc.create(USER, "TARGETED", "targeted-value", {
      scope: "agents",
      profile_ids: ["prof_a"],
    });

    const envForA = await svc.getDecryptedForProfile(USER, "prof_a");
    expect(envForA.TARGETED).toBe("targeted-value");

    const envForB = await svc.getDecryptedForProfile(USER, "prof_b");
    expect(envForB.TARGETED).toBeUndefined();
  });

  it("getDecryptedForProfile mixes scope='all' and scope='agents' correctly", async () => {
    await svc.create(USER, "ALWAYS", "v1");
    await svc.create(USER, "ONLY_A", "v2", { scope: "agents", profile_ids: ["prof_a"] });
    await svc.create(USER, "ONLY_B", "v3", { scope: "agents", profile_ids: ["prof_b"] });

    const envA = await svc.getDecryptedForProfile(USER, "prof_a");
    expect(envA).toEqual({ ALWAYS: "v1", ONLY_A: "v2" });

    const envB = await svc.getDecryptedForProfile(USER, "prof_b");
    expect(envB).toEqual({ ALWAYS: "v1", ONLY_B: "v3" });
  });

  it("getDecryptedForProfile is per-user — doesn't leak another user's secrets", async () => {
    await svc.create(USER, "ALICE_SECRET", "for-alice");
    await svc.create("user_bob", "BOB_SECRET", "for-bob");

    const aliceEnv = await svc.getDecryptedForProfile(USER, "prof_x");
    expect(aliceEnv.ALICE_SECRET).toBe("for-alice");
    expect(aliceEnv.BOB_SECRET).toBeUndefined();
  });

  it("list returns redacted values but real scope + profile_ids", async () => {
    await svc.create(USER, "FOO", "secret-foo");
    await svc.create(USER, "BAR", "secret-bar", {
      scope: "agents",
      profile_ids: ["prof_1"],
    });
    const list = await svc.list(USER);
    expect(list).toHaveLength(2);
    for (const s of list) expect(s.value).toBe("••••••••");

    const bar = list.find((s) => s.name === "BAR")!;
    expect(bar.scope).toBe("agents");
    expect(bar.profile_ids).toEqual(["prof_1"]);

    const foo = list.find((s) => s.name === "FOO")!;
    expect(foo.scope).toBe("all");
    expect(foo.profile_ids).toEqual([]);
  });

  it("delete only succeeds for the owning user", async () => {
    const s = await svc.create(USER, "FOO", "v");
    const wrongUser = await svc.delete(s.id, "user_bob");
    expect(wrongUser).toBe(false);

    // Still present
    const stillThere = await svc.list(USER);
    expect(stillThere).toHaveLength(1);

    const ok = await svc.delete(s.id, USER);
    expect(ok).toBe(true);

    const gone = await svc.list(USER);
    expect(gone).toHaveLength(0);
  });

  it("update returns null when the secret doesn't belong to the user", async () => {
    const s = await svc.create(USER, "FOO", "v");
    const result = await svc.update(s.id, "user_bob", { name: "BAR" });
    expect(result).toBeNull();

    // Original unchanged
    const list = await svc.list(USER);
    expect(list[0].name).toBe("FOO");
  });
});
