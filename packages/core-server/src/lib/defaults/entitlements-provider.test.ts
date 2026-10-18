import { describe, expect, it } from "vitest";
import type { EntitlementsUser } from "@vonzio/shared";
import { DefaultEntitlementsProvider } from "./entitlements-provider.js";

const user: EntitlementsUser = { id: "u1", email: "u1@example.com", role: "user" };

describe("DefaultEntitlementsProvider", () => {
  it("does not grant embed by default", async () => {
    const p = new DefaultEntitlementsProvider({ registrationEnabled: false });
    expect(await p.compute(user)).not.toContain("embed");
  });

  it("grants embed when embedEnabled is set", async () => {
    const p = new DefaultEntitlementsProvider({ registrationEnabled: false, embedEnabled: true });
    expect(await p.compute(user)).toContain("embed");
  });
});
