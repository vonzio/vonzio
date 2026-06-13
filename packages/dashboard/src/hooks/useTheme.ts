/**
 * Theme switcher. A *preference* — `auto` | `light` | `dark` — is persisted;
 * the resolved *surface* (`carbon` dark / `paper` light) is written to
 * `<html data-surface="...">`. Both palettes live in `brand/tokens.css`
 * (Paper at `:root`, Carbon at `[data-surface="carbon"]`).
 *
 *   auto  → follow the OS via `prefers-color-scheme` (re-resolves live)
 *   light → paper
 *   dark  → carbon
 *
 * The initial value is applied in `index.html` *before* React hydrates so we
 * never flash the wrong theme. This module keeps the DOM, localStorage, and
 * React state in sync afterwards.
 */
import { useEffect, useState, useSyncExternalStore } from "react";

/** What the user picked. */
export type ThemeMode = "auto" | "light" | "dark";
/** What actually renders (the resolved palette). */
export type Surface = "carbon" | "paper";

const STORAGE_KEY = "vonzio_surface";
const DEFAULT_MODE: ThemeMode = "auto";

/** The OS's current preference as a surface. */
function systemSurface(): Surface {
  if (typeof window === "undefined" || !window.matchMedia) return "carbon";
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "carbon" : "paper";
}

/** Resolve a preference to the concrete surface to apply. */
export function resolveSurface(mode: ThemeMode): Surface {
  if (mode === "light") return "paper";
  if (mode === "dark") return "carbon";
  return systemSurface();
}

/** Read the stored preference, migrating the legacy carbon/paper values. */
function readMode(): ThemeMode {
  if (typeof document === "undefined") return DEFAULT_MODE;
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "auto" || v === "light" || v === "dark") return v;
    if (v === "carbon") return "dark";  // legacy explicit dark
    if (v === "paper") return "light";  // legacy explicit light
  } catch { /* private mode, etc. */ }
  return DEFAULT_MODE;
}

/** Read the resolved surface currently applied to the DOM. */
function readSurface(): Surface {
  if (typeof document === "undefined") return "carbon";
  return document.documentElement.dataset.surface === "paper" ? "paper" : "carbon";
}

const listeners = new Set<() => void>();
function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}
function notify() { for (const fn of listeners) fn(); }

/** Persist a preference and apply its resolved surface to the DOM. */
function applyMode(mode: ThemeMode) {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.surface = resolveSurface(mode);
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* ignore */ }
  notify();
}

// When the preference is `auto`, follow live OS changes (e.g. the user flips
// their system theme, or a scheduled night shift kicks in). Registered once.
if (typeof window !== "undefined" && window.matchMedia) {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  const onChange = () => {
    if (readMode() === "auto") {
      document.documentElement.dataset.surface = systemSurface();
      notify();
    }
  };
  mq.addEventListener?.("change", onChange);
}

const ORDER: ThemeMode[] = ["auto", "light", "dark"];
/** Next preference in the cycle: auto → light → dark → auto. */
export function nextMode(m: ThemeMode): ThemeMode {
  return ORDER[(ORDER.indexOf(m) + 1) % ORDER.length];
}

/** Read + subscribe to the theme. Re-renders when mode or resolved surface changes. */
export function useTheme(): {
  mode: ThemeMode;
  surface: Surface;
  setMode: (m: ThemeMode) => void;
  cycle: () => void;
} {
  const mode = useSyncExternalStore(subscribe, readMode, () => DEFAULT_MODE);
  const surface = useSyncExternalStore(subscribe, readSurface, () => "carbon" as Surface);
  return {
    mode,
    surface,
    setMode: applyMode,
    cycle: () => applyMode(nextMode(readMode())),
  };
}

/** One-shot read of the resolved surface for non-subscribing module code. */
export function getSurface(): Surface { return readSurface(); }

/** Subscribe imperatively (for non-React modules like CodeBlock's highlighter). */
export function onSurfaceChange(fn: (s: Surface) => void): () => void {
  const handler = () => fn(readSurface());
  return subscribe(handler);
}

/** Re-apply the stored preference on first React mount, in case the inline
 * index.html script was bypassed (SSR, embed) or the OS changed since. */
export function useApplyStoredTheme() {
  const [applied, setApplied] = useState(false);
  useEffect(() => {
    if (applied) return;
    applyMode(readMode());
    setApplied(true);
  }, [applied]);
}
