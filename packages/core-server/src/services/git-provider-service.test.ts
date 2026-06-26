import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { GitProviderService, type InstallationTokenMinter } from "./git-provider-service.js";

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

describe("GitProviderService — GitHub App installs", () => {
  let handle: DB;
  let minted: string[];
  let svc: GitProviderService;

  beforeEach(async () => {
    handle = await createTestDB();
    minted = [];
    const minter: InstallationTokenMinter = {
      getInstallationToken: async (id) => {
        minted.push(id);
        return `ghs_for_${id}`;
      },
    };
    svc = new GitProviderService(handle.db, ENCRYPTION_KEY, minter);
  });

  afterEach(async () => {
    await handle.close();
  });

  it("creates a github_app provider with no stored token", async () => {
    const p = await svc.createFromGitHubApp({ installationId: "555", accountLogin: "Fucec", userId: "u1" });
    expect(p.auth_method).toBe("github_app");
    expect(p.installation_id).toBe("555");
    expect(p.user_name).toBe("Fucec");
    expect(p.name).toBe("GitHub App (Fucec)");
    // Listing never exposes a token for app rows.
    const listed = (await svc.list("u1")).find((x) => x.id === p.id);
    expect(listed?.token).toBeUndefined();
  });

  it("mints a fresh installation token in getWithSecret", async () => {
    const p = await svc.createFromGitHubApp({ installationId: "777", accountLogin: "acme", userId: "u1" });
    const secret = await svc.getWithSecret(p.id);
    expect(secret?.token).toBe("ghs_for_777");
    expect(minted).toEqual(["777"]);
  });

  it("upserts on re-install for the same (user, installation)", async () => {
    const a = await svc.createFromGitHubApp({ installationId: "888", accountLogin: "old", userId: "u1" });
    const b = await svc.createFromGitHubApp({ installationId: "888", accountLogin: "new", userId: "u1" });
    expect(b.id).toBe(a.id); // same row, updated
    expect(b.user_name).toBe("new");
    expect((await svc.list("u1")).length).toBe(1);
  });

  it("returns no token when the app row has no minter wired", async () => {
    const noMinter = new GitProviderService(handle.db, ENCRYPTION_KEY);
    const p = await svc.createFromGitHubApp({ installationId: "999", accountLogin: "x", userId: "u1" });
    const secret = await noMinter.getWithSecret(p.id);
    expect(secret?.token).toBeUndefined();
  });

  it("still decrypts real tokens for PAT providers", async () => {
    const p = await svc.create({ name: "pat", type: "github", token: "ghp_real" });
    const secret = await svc.getWithSecret(p.id);
    expect(secret?.token).toBe("ghp_real");
  });
});
