import { createContext, useContext } from "react";

export interface AppConfig {
  /**
   * True when the server is multi-tenant (REGISTRATION_ENABLED=true).
   * Used to gate multi-tenant-only UI like /admin (invites, user
   * management). Single-user OSS instances run with this false and
   * hide those surfaces.
   */
  registrationEnabled: boolean;
}

export const AppConfigContext = createContext<AppConfig>({
  registrationEnabled: false,
});

export function useAppConfig(): AppConfig {
  return useContext(AppConfigContext);
}
