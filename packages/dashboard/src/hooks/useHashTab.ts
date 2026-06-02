import { useCallback, useEffect, useState } from "react";

/**
 * Persist the active tab in the URL hash so deep-links and back/forward
 * navigation restore the right view. Used by Settings, Admin, and
 * (in cp-dashboard) OrgSettings — all of which previously copy-pasted
 * this state machine.
 *
 * Returns the active tab id and a setter that writes both local state
 * and `window.location.hash`. The hash is the source of truth on mount;
 * a hash that isn't in `validIds` is ignored and the default kicks in.
 *
 * Cross-tab navigation is handled by the `hashchange` listener — when
 * the user hits Back / Forward (or pastes a new URL into the same tab),
 * the tab updates without remounting.
 */
export function useHashTab(
  validIds: readonly string[],
  defaultId: string,
): [string, (id: string) => void] {
  const initial = (): string => {
    if (typeof window === "undefined") return defaultId;
    const h = window.location.hash.slice(1);
    return validIds.includes(h) ? h : defaultId;
  };
  const [active, setActiveRaw] = useState<string>(initial);

  const setActive = useCallback(
    (id: string) => {
      setActiveRaw(id);
      if (typeof window !== "undefined") window.location.hash = id;
    },
    [],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      const h = window.location.hash.slice(1);
      if (validIds.includes(h)) setActiveRaw(h);
    };
    window.addEventListener("hashchange", handler);
    return () => window.removeEventListener("hashchange", handler);
    // validIds is a frozen list at the call site; re-attaching the
    // listener every render is unnecessary. Caller passes a stable
    // module-level constant.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return [active, setActive];
}
