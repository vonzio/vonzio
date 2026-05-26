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
    const ents: string[] = ["self_hosted"];
    if (user.role === "admin") {
      ents.push("admin");
      if (this.opts.registrationEnabled) ents.push("admin_multitenant");
    }
    return ents;
  }
}
