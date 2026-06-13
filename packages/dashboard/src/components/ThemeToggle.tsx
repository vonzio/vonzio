import { Sun, Moon, Monitor } from "lucide-react";
import { useTheme, nextMode, type ThemeMode } from "@/hooks/useTheme.js";

const LABEL: Record<ThemeMode, string> = {
  auto: "Auto (system)",
  light: "Light",
  dark: "Dark",
};

/**
 * Single cycle button: Auto → Light → Dark → Auto. The icon reflects the
 * current preference (Monitor = auto, Sun = light, Moon = dark); the tooltip
 * names the current mode and the next one. Pass `className` to restyle for a
 * given surface (defaults to the topbar icon-button style).
 */
export function ThemeToggle({ className }: { className?: string }) {
  const { mode, cycle } = useTheme();
  const Icon = mode === "auto" ? Monitor : mode === "light" ? Sun : Moon;
  return (
    <button
      type="button"
      onClick={cycle}
      className={className ?? "vz-topbar__icon-btn"}
      title={`Theme: ${LABEL[mode]} — click for ${LABEL[nextMode(mode)]}`}
      aria-label={`Theme: ${LABEL[mode]}. Click to switch to ${LABEL[nextMode(mode)]}.`}
    >
      <Icon size={16} />
    </button>
  );
}
