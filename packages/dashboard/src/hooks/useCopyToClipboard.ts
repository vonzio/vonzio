import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Copy text to the clipboard with transient "copied" feedback.
 *
 * Handles the two things inline `navigator.clipboard.writeText` calls usually
 * miss: it clears the reset timer on unmount (no setState-after-unmount), and
 * it swallows clipboard rejections (insecure context / denied permission)
 * instead of throwing an unhandled promise rejection.
 */
export function useCopyToClipboard(resetMs = 1500): readonly [boolean, (text: string) => void] {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const copy = useCallback((text: string) => {
    void Promise.resolve(navigator.clipboard?.writeText(text))
      .then(() => {
        setCopied(true);
        if (timer.current) clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), resetMs);
      })
      .catch(() => { /* insecure context / permission denied — no-op */ });
  }, [resetMs]);

  return [copied, copy] as const;
}
