import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { type DB } from "../db/index.js";
import { createTestDB } from "../db/test-utils.js";
import { ApiKeyService } from "./api-key-service.js";
import { runWithOrgId } from "../lib/active-org.js";

const ENCRYPTION_KEY = "a]3Kf9$mPqR7vXw2LnB5tYhJ8cDgE0sU";

describe("ApiKeyService.list — org-scoped shared-key visibility", () => {
  let handle: DB;
  let svc: ApiKeyService;

  beforeEach(async () => {
    handle = await createTestDB();
    svc = new ApiKeyService(handle.db, ENCRYPTION_KEY);
  });

  afterEach(async () => {
    await handle.close();
  });

  const idsFor = async (userId: string, role: string, activeOrg: string | null) =>
    (await runWithOrgId(activeOrg, () => svc.list(userId, role))).map((k) => k.id);

  it("keeps an admin cross-user share visible to a grantee who is not a member of the key's org", async () => {
    // Admin creates a shared key while their own org is active → key carries
    // the admin's org_id; the grantee ("testeur") is granted via the junction.
    const key = await runWithOrgId("org-admin", () =>
      svc.create({ name: "admin-key", provider: "api_key", api_key: "sk-x", allowed_user_ids: ["testeur"] }),
    );

    // testeur belongs only to their own org, never org-admin.
    svc.setOrgMembershipResolver(async () => new Set(["org-testeur"]));

    // Visible with the grantee's own org active (the real-world case)…
    expect(await idsFor("testeur", "user", "org-testeur")).toContain(key.id);
    // …and with no active org pinned.
    expect(await idsFor("testeur", "user", null)).toContain(key.id);
  });

  it("keeps an org-materialized granted key visible from ANY of the member's org contexts (union model)", async () => {
    const key = await runWithOrgId("org-team", () =>
      svc.create({ name: "team-key", provider: "api_key", api_key: "sk-y", allowed_user_ids: ["member1"] }),
    );

    // member1 is a member of the team org (org-materialized share).
    svc.setOrgMembershipResolver(async () => new Set(["org-team", "org-personal"]));

    // The explicit grant wins: visible from their personal org context…
    expect(await idsFor("member1", "user", "org-personal")).toContain(key.id);
    // …from the team org, and with no active org pinned.
    expect(await idsFor("member1", "user", "org-team")).toContain(key.id);
    expect(await idsFor("member1", "user", null)).toContain(key.id);
  });

  it("still org-gates the implicit admin path (admin of another org, no grant)", async () => {
    // Fully-shared key in org-team; admin_x has NO junction grant and is a
    // member of org-team — role-based visibility must not cross org contexts.
    const key = await runWithOrgId("org-team", () =>
      svc.create({ name: "team-key", provider: "api_key", api_key: "sk-t" }),
    );
    svc.setOrgMembershipResolver(async () => new Set(["org-team", "org-personal"]));

    expect(await idsFor("admin_x", "admin", "org-personal")).not.toContain(key.id);
    expect(await idsFor("admin_x", "admin", "org-team")).toContain(key.id);
  });

  it("does not show a shared key to a user without a junction grant", async () => {
    const key = await runWithOrgId("org-admin", () =>
      svc.create({ name: "admin-key", provider: "api_key", api_key: "sk-z", allowed_user_ids: ["testeur"] }),
    );
    svc.setOrgMembershipResolver(async () => new Set(["org-other"]));

    expect(await idsFor("stranger", "user", null)).not.toContain(key.id);
  });

  it("shows an OWNED key (user_id set) to a grantee added via the junction", async () => {
    // Admin's own key (not a fully-shared key) with the grantee in allowed_user_ids.
    const key = await runWithOrgId("org-admin", () =>
      svc.create(
        { name: "admins-own-key", provider: "api_key", api_key: "sk-o", allowed_user_ids: ["testeur"] },
        "admin_1", // owner — user_id is set, NOT null
      ),
    );
    svc.setOrgMembershipResolver(async () => new Set(["org-testeur"]));

    expect(await idsFor("testeur", "user", "org-testeur")).toContain(key.id);
  });

  it("does NOT leak another user's personal key to an admin (no junction grant)", async () => {
    const key = await runWithOrgId("org-bob", () =>
      svc.create({ name: "bobs-key", provider: "api_key", api_key: "sk-b" }, "bob"),
    );
    svc.setOrgMembershipResolver(async () => new Set(["org-admin"]));

    // Admin viewing their own key list must not see bob's personal key.
    expect(await idsFor("admin_1", "admin", "org-admin")).not.toContain(key.id);
  });
});
