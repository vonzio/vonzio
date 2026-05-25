import { cn } from "../lib/utils.js";

const variants = {
  default: "bg-secondary text-foreground",
  success: "bg-emerald-50 text-emerald-600",
  warning: "bg-accent/10 text-accent",
  error: "bg-red-50 text-destructive",
  info: "bg-accent/10 text-accent",
};

interface BadgeProps {
  children: React.ReactNode;
  variant?: keyof typeof variants;
  className?: string;
}

export function Badge({ children, variant = "default", className }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium",
        variants[variant],
        className,
      )}
    >
      {children}
    </span>
  );
}

const statusMap: Record<string, keyof typeof variants> = {
  done: "success",
  active: "success",
  running: "info",
  resumable: "info",
  queued: "warning",
  submitted: "warning",
  idle: "warning",
  paused: "warning",
  failed: "error",
  expired: "error",
  cancelled: "default",
};

export function getStatusVariant(status: string): keyof typeof variants {
  return statusMap[status] ?? "default";
}
