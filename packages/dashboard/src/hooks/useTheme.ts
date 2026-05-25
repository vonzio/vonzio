/**
 * Theme switcher: toggles `<html data-surface="...">` between Carbon (dark)
 * and Paper (light). Both palettes are defined in `brand/tokens.css`:
 * Paper at `:root`, Carbon at `[data-surface="carbon"]`.
 *
 * The initial value is read in `index.html` *before* React hydrates so we
 * never flash the wrong theme. This module just keeps the DOM and React
 * state in sync after that.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

export type Surface = "carbon" | "paper";

const STORAGE_KEY = "vonzio_surface";
const DEFAULT_SURFACE: Surface = "carbon";

function readSurface(): Surface {
  if (typeof document === "undefined") return DEFAULT_SURFACE;
  const v = document.documentElement.dataset.surface;
  return v === "paper" ? "paper" : "carbon";
}

function writeSurface(s: Surface) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.surface = s;
  try { localStorage.setItem(STORAGE_KEY, s); } catch { /* private mode, etc. */ }
  // Notify all subscribers (other components using useTheme).
  for (const fn of listeners) fn();
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Read + subscribe to the current surface. Re-renders when it changes. */
export function useTheme(): { surface: Surface; setSurface: (s: Surface) => void; toggle: () => void } {
  const surface = useSyncExternalStore(subscribe, readSurface, () => DEFAULT_SURFACE);
  return {
    surface,
    setSurface: writeSurface,
    toggle: () => writeSurface(surface === "carbon" ? "paper" : "carbon"),
  };
}

/** One-shot read for module code that doesn't want to subscribe. */
export function getSurface(): Surface { return readSurface(); }

/** Subscribe imperatively (for non-React modules like CodeBlock's highlighter). */
export function onSurfaceChange(fn: (s: Surface) => void): () => void {
  const handler = () => fn(readSurface());
  return subscribe(handler);
}

/** Persist the localStorage value back to DOM on first React mount, just in
 * case the inline script in index.html was bypassed (e.g. SSR, embed). */
export function useApplyStoredTheme() {
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (applied) return;
    try {
      const saved = localStorage.getItem(STORAGE_KEY) as Surface | null;
      if (saved === "paper" || saved === "carbon") {
        if (document.documentElement.dataset.surface !== saved) {
          document.documentElement.dataset.surface = saved;
        }
      } else if (!document.documentElement.dataset.surface) {
        document.documentElement.dataset.surface = DEFAULT_SURFACE;
      }
    } catch { /* ignore */ }
    setApplied(true);
  }, [applied]);
}
