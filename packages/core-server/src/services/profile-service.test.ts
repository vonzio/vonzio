import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { ProfileService } from "./profile-service.js";
import { ApiKeyService } from "./api-key-service.js";

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

describe("ProfileService", () => {
  let handle: DB;
  let profileService: ProfileService;
  let apiKeyService: ApiKeyService;

  beforeEach(async () => {
    handle = await createTestDB();
    apiKeyService = new ApiKeyService(handle.db, ENCRYPTION_KEY);
    profileService = new ProfileService(handle.db, ENCRYPTION_KEY, apiKeyService);
  });

  afterEach(async () => {
    await handle.close();
  });

  it("creates a profile with basic fields", async () => {
    const profile = await profileService.create({
      name: "test-profile",
      default_tools: ["Read", "Grep"],
    });

    expect(profile.id).toMatch(/^prof_/);
    expect(profile.name).toBe("test-profile");
    expect(profile.default_tools).toEqual(["Read", "Grep"]);
  });

  it("creates a profile linked to an API key", async () => {
    const key = await apiKeyService.create({
      name: "test-key",
      provider: "api_key",
      api_key: "sk-ant-api03-real-secret-key",
    });

    const profile = await profileService.create({
      name: "linked-profile",
      api_key_id: key.id,
    });

    expect(profile.api_key_id).toBe(key.id);

    // Resolved profile should include decrypted key
    const resolved = await profileService.getResolved(profile.id);
    expect(resolved).not.toBeNull();
    expect(resolved!.resolved_api_key).toBe("sk-ant-api03-real-secret-key");
    expect(resolved!.resolved_provider).toBe("api_key");
  });

  it("encrypts MCP server secrets in DB", async () => {
    const profile = await profileService.create({
      name: "mcp-test",
      mcp_servers: [{
        name: "test-server",
        type: "stdio",
        command: "node",
        args: ["server.js"],
        env: { SECRET_KEY: "my-secret-value" },
      }],
    });

    // Redacted via get()
    const redacted = await profileService.get(profile.id);
    expect(redacted!.mcp_servers[0].env!.SECRET_KEY).toBe("••••••••");

    // Decrypted via getWithSecrets()
    const full = await profileService.getWithSecrets(profile.id);
    expect(full!.mcp_servers[0].env!.SECRET_KEY).toBe("my-secret-value");
  });

  it("returns null for non-existent profile", async () => {
    const result = await profileService.get("prof_nonexistent");
    expect(result).toBeNull();
  });

  it("lists profiles", async () => {
    await profileService.create({ name: "profile-a" });
    await profileService.create({ name: "profile-b" });

    const list = await profileService.list();
    expect(list).toHaveLength(2);
    expect(list.map((p) => p.name)).toContain("profile-a");
    expect(list.map((p) => p.name)).toContain("profile-b");
  });

  it("deletes a profile", async () => {
    const profile = await profileService.create({ name: "to-delete" });
    const result = await profileService.delete(profile.id);
    expect(result.deleted).toBe(true);

    const fetched = await profileService.get(profile.id);
    expect(fetched).toBeNull();
  });

  it("returns not deleted for non-existent profile", async () => {
    const result = await profileService.delete("prof_nonexistent");
    expect(result.deleted).toBe(false);
  });
});

describe("ApiKeyService", () => {
  let handle: DB;
  let service: ApiKeyService;

  beforeEach(async () => {
    handle = await createTestDB();
    service = new ApiKeyService(handle.db, ENCRYPTION_KEY);
  });

  afterEach(async () => {
    await handle.close();
  });

  it("creates an API key with encrypted value", async () => {
    const key = await service.create({
      name: "test-key",
      provider: "api_key",
      api_key: "sk-ant-api03-real-secret",
    });

    expect(key.id).toMatch(/^apk_/);
    expect(key.name).toBe("test-key");
    expect(key.provider).toBe("api_key");
    expect(key.api_key).toBe("••••••••"); // create returns redacted
  });

  it("retrieves redacted key via get, decrypted via getWithSecrets", async () => {
    const created = await service.create({
      name: "test",
      provider: "subscription_token",
      auth_token: "oat-token-value",
    });

    const redacted = await service.get(created.id);
    expect(redacted).not.toBeNull();
    expect(redacted!.auth_token).toBe("••••••••");

    const full = await service.getWithSecrets(created.id);
    expect(full!.auth_token).toBe("oat-token-value");
  });

  it("lists keys with redacted secrets", async () => {
    await service.create({ name: "key-a", provider: "api_key", api_key: "secret-a" });
    await service.create({ name: "key-b", provider: "subscription_token", auth_token: "secret-b" });

    const list = await service.list();
    expect(list).toHaveLength(2);
    expect(list[0].api_key).toBe("••••••••");
    expect(list[1].auth_token).toBe("••••••••");
  });

  it("deletes an API key", async () => {
    const key = await service.create({ name: "del", provider: "api_key", api_key: "k" });
    const result = await service.delete(key.id);
    expect(result.deleted).toBe(true);

    const fetched = await service.get(key.id);
    expect(fetched).toBeNull();
  });

  it("returns null for non-existent key", async () => {
    const result = await service.get("apk_nonexistent");
    expect(result).toBeNull();
  });
});
