import type {
  EntitlementsProvider,
  EntitlementsUser,
} from "@vonzio/shared";

export interface DefaultEntitlementsProviderOptions {
  registrationEnabled: boolean;
}

export class DefaultEntitlementsProvider implements EntitlementsProvider {
  constructor(private readonly opts: DefaultEntitlementsProviderOptions) {}

  async compute(user: EntitlementsUser): Promise<string[]> {
    // `subscription_oauth` (ChatGPT/Codex subscription login) is on by default on
    // self-host — the operator runs it on their own box with their own token, the
    // tolerated local pattern. SaaS overrides compute() to gate it behind an admin
    // allowlist (a per-user feature flag). See feature 0047.
    const ents: string[] = ["self_hosted", "subscription_oauth"];
    if (user.role === "admin") {
      ents.push("admin");
      if (this.opts.registrationEnabled) ents.push("admin_multitenant");
    }
    return ents;
  }
}
