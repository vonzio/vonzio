/**
 * Fire-and-forget event tracking. Posts to /v1/events.
 * Errors are swallowed — tracking must never surface in the UI.
 */
export function track(event: string, properties?: Record<string, unknown>): void {
  try {
    void fetch("/v1/events", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event,
        properties,
        path: typeof window !== "undefined" ? window.location.pathname : undefined,
      }),
      credentials: "include",
      keepalive: true,
    }).catch(() => {});
  } catch {
    // no-op
  }
}

/**
 * Register a single document-level click listener that fires a tracking event
 * for any element (or ancestor) with a `data-track` attribute. Other
 * `data-track-*` attributes become event properties.
 *
 * Example: <button data-track="invite.sent" data-track-role="admin">…</button>
 *   → track("ui.click.invite.sent", { role: "admin" })
 */
let initialized = false;
export function initClickTracking(): void {
  if (initialized || typeof document === "undefined") return;
  initialized = true;

  document.addEventListener("click", (e) => {
    const target = e.target as HTMLElement | null;
    if (!target) return;
    const el = target.closest<HTMLElement>("[data-track]");
    if (!el) return;

    const name = el.dataset.track;
    if (!name) return;

    const props: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(el.dataset)) {
      if (k === "track" || !k.startsWith("track") || v == null) continue;
      // strip the "track" prefix and lowercase the first letter
      const key = k.slice(5, 6).toLowerCase() + k.slice(6);
      props[key] = v;
    }

    track(`ui.click.${name}`, Object.keys(props).length ? props : undefined);
  });
}
