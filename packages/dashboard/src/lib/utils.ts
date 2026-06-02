import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function formatDate(isoString: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(isoString));
}

export function truncateId(id: string, len = 12): string {
  return id.length > len ? id.slice(0, len) + "..." : id;
}

export function formatCost(usd: number): string {
  return `$${usd.toFixed(2)}`;
}

export function formatRelative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function hasFlag(flags: string | undefined, flag: string): boolean {
  return (flags ?? "").split(",").includes(flag);
}

export function toggleFlag(flags: string | undefined, flag: string): string {
  const arr = (flags ?? "").split(",").filter(Boolean);
  return arr.includes(flag) ? arr.filter((f) => f !== flag).join(",") : [...arr, flag].join(",");
}

/**
 * Server-side slug validation pattern. Mirrors cp-server's auth/slug.ts
 * SLUG_RE — first character must be lowercase alphanumeric, then 1-62
 * more lowercase alphanumeric or dashes. Cross-tier source of truth on
 * the client side; forms validate locally with this so users see inline
 * feedback before the server's 400 response.
 *
 * If the server changes the rule, change this regex too. The duplication
 * is currently localized to two places (here + server); a future
 * refactor can promote both to packages/shared.
 */
export const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,62}$/;
export const SLUG_MAX_LEN = 63;

/**
 * Canonical kebab-case slug derivation. Lowercases, collapses runs of
 * non-alphanumeric characters into single dashes, trims dashes from
 * start/end, caps at SLUG_MAX_LEN. NFKD-normalises first so accented
 * characters fold to their ASCII base ("Café" → "cafe", not "caf").
 *
 * Used wherever a user-facing name needs an auto-derived URL-safe
 * identifier. Previously duplicated across pages (EditAgent, MyAgents)
 * and cp-dashboard org dialogs with subtly different regexes.
 */
export function slugify(name: string, maxLen: number = SLUG_MAX_LEN): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "") // strip combining diacritics (Café → Cafe)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen);
}
