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
