import { createContext, useContext } from "react";

export interface User {
  id: string;
  email: string;
  name: string;
  role: string;
  feature_flags: string;
}

export const UserContext = createContext<User | null>(null);

export function useUser(): User {
  const user = useContext(UserContext);
  if (!user) throw new Error("useUser must be used within UserContext.Provider");
  return user;
}

/**
 * Like useUser() but returns null instead of throwing when no provider
 * is mounted. For components rendered in BOTH authenticated dashboard
 * routes AND public/embed routes (e.g. MessageList in /chat) — the
 * dashboard wraps everything in UserContext.Provider, but public routes
 * intentionally don't (no session, no user).
 */
export function useOptionalUser(): User | null {
  return useContext(UserContext);
}
