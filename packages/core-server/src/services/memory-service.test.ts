import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { MemoryService } from "./memory-service.js";

describe("MemoryService", () => {
  let handle: DB;
  let service: MemoryService;
  const userId = "user_test_123";
  const profileId = "prof_test_456";

  beforeEach(async () => {
    handle = await createTestDB();
    service = new MemoryService(handle.db);
  });

  afterEach(async () => {
    await handle.close();
  });

  // --------------- CRUD basics ---------------

  it("creates a memory with correct fields", async () => {
    const mem = await service.create(userId, {
      name: "deployment process",
      type: "feedback",
      body: "Always run migrations before deploying",
      description: "deploy notes",
      profile_id: profileId,
    });

    expect(mem.id).toMatch(/^mem_/);
    expect(mem.user_id).toBe(userId);
    expect(mem.profile_id).toBe(profileId);
    expect(mem.type).toBe("feedback");
    expect(mem.name).toBe("deployment process");
    expect(mem.body).toBe("Always run migrations before deploying");
    expect(mem.description).toBe("deploy notes");
    expect(mem.importance).toBe(0);
    expect(mem.last_accessed_at).toBeNull();
    expect(mem.created_at).toBeTruthy();
    expect(mem.updated_at).toBeTruthy();
  });

  it("gets a memory by id", async () => {
    const created = await service.create(userId, {
      name: "test memory",
      type: "user",
      body: "some body",
    });

    const fetched = await service.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.name).toBe("test memory");
    expect(fetched!.body).toBe("some body");
  });

  it("returns null for non-existent memory", async () => {
    const result = await service.get("mem_nope");
    expect(result).toBeNull();
  });

  it("updates a memory", async () => {
    const created = await service.create(userId, {
      name: "original",
      type: "user",
      body: "original body",
    });

    const originalUpdatedAt = created.updated_at;

    // Small delay so updated_at differs
    await new Promise((r) => setTimeout(r, 10));

    const updated = await service.update(created.id, userId, {
      body: "updated body",
    });

    expect(updated).not.toBeNull();
    expect(updated!.body).toBe("updated body");
    expect(updated!.name).toBe("original");
    expect(updated!.updated_at).not.toBe(originalUpdatedAt);
  });

  it("returns null when updating non-existent memory", async () => {
    const result = await service.update("mem_nonexistent", userId, {
      body: "nope",
    });
    expect(result).toBeNull();
  });

  it("returns null when updating another user's memory", async () => {
    const created = await service.create("user_a", {
      name: "private",
      type: "user",
      body: "user a's memory",
    });

    const result = await service.update(created.id, "user_b", {
      body: "hijacked",
    });
    expect(result).toBeNull();

    // Verify original is unchanged
    const original = await service.get(created.id);
    expect(original!.body).toBe("user a's memory");
  });

  it("deletes a memory", async () => {
    const created = await service.create(userId, {
      name: "to-delete",
      type: "user",
      body: "bye",
    });

    const deleted = await service.delete(created.id, userId);
    expect(deleted).toBe(true);

    const fetched = await service.get(created.id);
    expect(fetched).toBeNull();
  });

  it("returns false when deleting another user's memory", async () => {
    const created = await service.create("user_a", {
      name: "protected",
      type: "user",
      body: "not yours",
    });

    const result = await service.delete(created.id, "user_b");
    expect(result).toBe(false);

    // Original still exists
    const fetched = await service.get(created.id);
    expect(fetched).not.toBeNull();
  });

  it("bulk deletes by type", async () => {
    await service.create(userId, { name: "fb1", type: "feedback", body: "a" });
    await service.create(userId, { name: "fb2", type: "feedback", body: "b" });
    await service.create(userId, { name: "usr1", type: "user", body: "c" });

    const count = await service.bulkDelete(userId, { type: "feedback" });
    expect(count).toBe(2);

    // The user-type memory should remain
    const remaining = await service.list(userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].type).toBe("user");
  });

  it("bulk deletes by profile", async () => {
    await service.create(userId, {
      name: "p1",
      type: "user",
      body: "a",
      profile_id: profileId,
    });
    await service.create(userId, {
      name: "p2",
      type: "user",
      body: "b",
      profile_id: profileId,
    });
    await service.create(userId, { name: "no-profile", type: "user", body: "c" });

    const count = await service.bulkDelete(userId, { profileId });
    expect(count).toBe(2);

    // The one without profileId should remain
    const remaining = await service.list(userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].name).toBe("no-profile");
  });

  // --------------- List & scope ---------------

  it("lists user-scoped memories", async () => {
    await service.create(userId, { name: "global1", type: "user", body: "a" });
    await service.create(userId, { name: "global2", type: "user", body: "b" });
    await service.create(userId, {
      name: "profile-specific",
      type: "user",
      body: "c",
      profile_id: profileId,
    });

    const list = await service.list(userId);
    expect(list).toHaveLength(2);
    expect(list.map((m) => m.name)).not.toContain("profile-specific");
  });

  it("lists profile-scoped memories includes user-scoped", async () => {
    await service.create(userId, { name: "global1", type: "user", body: "a" });
    await service.create(userId, { name: "global2", type: "user", body: "b" });
    await service.create(userId, {
      name: "profile-specific",
      type: "user",
      body: "c",
      profile_id: profileId,
    });

    const list = await service.list(userId, { profileId });
    expect(list).toHaveLength(3);
    expect(list.map((m) => m.name)).toContain("profile-specific");
    expect(list.map((m) => m.name)).toContain("global1");
    expect(list.map((m) => m.name)).toContain("global2");
  });

  it("filters by type", async () => {
    await service.create(userId, { name: "fb", type: "feedback", body: "a" });
    await service.create(userId, { name: "usr", type: "user", body: "b" });

    const list = await service.list(userId, { type: "feedback" });
    expect(list).toHaveLength(1);
    expect(list[0].type).toBe("feedback");
  });

  it("orders by updated_at DESC", async () => {
    const a = await service.create(userId, { name: "older", type: "user", body: "a" });

    // Force a later updated_at by updating
    await new Promise((r) => setTimeout(r, 10));
    const b = await service.create(userId, { name: "newer", type: "user", body: "b" });

    const list = await service.list(userId);
    expect(list).toHaveLength(2);
    expect(list[0].name).toBe("newer");
    expect(list[1].name).toBe("older");
  });

  it("respects limit and offset", async () => {
    for (let i = 0; i < 5; i++) {
      await service.create(userId, { name: `mem-${i}`, type: "user", body: `body-${i}` });
    }

    const page1 = await service.list(userId, { limit: 2 });
    expect(page1).toHaveLength(2);

    const page2 = await service.list(userId, { limit: 2, offset: 2 });
    expect(page2).toHaveLength(2);

    // Pages should have different items
    const page1Ids = page1.map((m) => m.id);
    const page2Ids = page2.map((m) => m.id);
    expect(page1Ids).not.toEqual(page2Ids);
  });

  // --------------- Search ---------------

  it("searches by name similarity", async () => {
    await service.create(userId, {
      name: "deployment process documentation",
      type: "user",
      body: "Steps for deploying to production server",
    });
    await service.create(userId, {
      name: "unrelated cooking recipe",
      type: "user",
      body: "How to make pasta from scratch",
    });

    const results = await service.search(userId, { query: "deployment" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].name).toContain("deployment");
  });

  it("search falls back to ILIKE for short queries", async () => {
    await service.create(userId, {
      name: "database connection info",
      type: "user",
      body: "DB host is localhost, port 5432",
    });

    const results = await service.search(userId, { query: "DB" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].body).toContain("DB");
  });

  it("search respects type filter", async () => {
    await service.create(userId, {
      name: "deployment feedback notes",
      type: "feedback",
      body: "Deployment was smooth and fast",
    });
    await service.create(userId, {
      name: "deployment user notes",
      type: "user",
      body: "Deployment requires SSH access",
    });

    const results = await service.search(userId, {
      query: "deployment",
      type: "feedback",
    });
    expect(results).toHaveLength(1);
    expect(results[0].type).toBe("feedback");
  });

  it("search returns empty for no matches", async () => {
    await service.create(userId, {
      name: "something real",
      type: "user",
      body: "actual content here",
    });

    const results = await service.search(userId, { query: "zzzznonexistent" });
    expect(results).toHaveLength(0);
  });

  // --------------- L0 retrieval (getTopMemories) ---------------

  it("returns memories within token budget", async () => {
    // "short note: small body" = ~22 chars => ~6 tokens
    await service.create(userId, {
      name: "short note",
      type: "user",
      body: "small body",
    });

    const withinBudget = await service.getTopMemories(userId, undefined, 50);
    expect(withinBudget).toHaveLength(1);

    const tooSmallBudget = await service.getTopMemories(userId, undefined, 1);
    expect(tooSmallBudget).toHaveLength(0);
  });

  it("prioritizes feedback over other types", async () => {
    await service.create(userId, {
      name: "reference info",
      type: "reference",
      body: "some reference data",
    });
    await service.create(userId, {
      name: "feedback info",
      type: "feedback",
      body: "some feedback data",
    });

    const results = await service.getTopMemories(userId, undefined, 500);
    expect(results.length).toBe(2);
    expect(results[0].type).toBe("feedback");
    expect(results[1].type).toBe("reference");
  });

  it("returns empty when no memories exist", async () => {
    const results = await service.getTopMemories(userId);
    expect(results).toHaveLength(0);
  });

  // --------------- Touch ---------------

  it("touch updates last_accessed_at and increments importance", async () => {
    const created = await service.create(userId, {
      name: "touchable",
      type: "user",
      body: "touch me",
    });

    expect(created.importance).toBe(0);
    expect(created.last_accessed_at).toBeNull();

    await service.touch(created.id);

    const fetched = await service.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.importance).toBe(1);
    expect(fetched!.last_accessed_at).not.toBeNull();
  });
});
