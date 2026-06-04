import { createContext, useContext, type ReactNode } from "react";
import type { Entitlement } from "./types.js";

const EntitlementsContext = createContext<Entitlement[]>([]);

export function EntitlementsProvider({
  value,
  children,
}: {
  value: Entitlement[];
  children: ReactNode;
}) {
  return (
    <EntitlementsContext.Provider value={value}>
      {children}
    </EntitlementsContext.Provider>
  );
}

export function useEntitlements(): Entitlement[] {
  return useContext(EntitlementsContext);
}

export function useHas(entitlement?: Entitlement): boolean {
  const entitlements = useContext(EntitlementsContext);
  if (!entitlement) return true;
  return entitlements.includes(entitlement);
}
