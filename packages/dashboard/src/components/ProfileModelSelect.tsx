/**
 * ProfileModelSelect — model picker for the Edit Agent dialog.
 *
 * One list, no hidden resolution magic. Sourced live from the profile's
 * API key via /v1/profiles/:id/models, so it stays current at Anthropic's
 * pace instead of waiting for the next SDK pin bump.
 *
 *   ┌────────────────────────────────┐
 *   │ Default          (SDK chooses) │
 *   │ ─────────────                  │
 *   │ Claude Opus 4.7                │
 *   │   claude-opus-4-7              │
 *   │ Claude Sonnet 4.6              │
 *   │   claude-sonnet-4-6            │
 *   │ Claude Haiku 4.5               │
 *   │   claude-haiku-4-5-20251001    │
 *   └────────────────────────────────┘
 *
 * Aliases (`sonnet` / `opus` / `haiku`) are intentionally NOT offered for
 * new picks — they were "auto-upgrade at SDK bump time," which gave the
 * impression of being live but actually lagged the live list. Profiles
 * created with an alias keep working (the SDK still resolves them), and
 * if a profile already has an alias or an unknown pin we surface it as
 * a one-off entry so the user can see what's stored before re-choosing.
 *
 * Without a profileId (new profile being created) only the `Default`
 * entry shows; user can pin a specific version after the first save.
 */
import { useEffect, useRef, useState } from "react";
import { fetchProfileModels, type ProfileModel } from "../api/client.js";
import { Icon } from "../brand/components.js";

interface Props {
  /** Existing profile's id. Omit when creating a new profile (live list unavailable). */
  profileId?: string | null;
  value: string;
  onChange: (v: string) => void;
  disabled?: boolean;
}

// Legacy alias labels kept for one purpose only: if a profile's stored
// model is "sonnet" / "opus" / "haiku", we still need to render something
// human in the trigger. Not added to the menu options.
const LEGACY_ALIAS_LABEL: Record<string, string> = {
  sonnet: "Sonnet (legacy alias)",
  opus: "Opus (legacy alias)",
  haiku: "Haiku (legacy alias)",
};

export function ProfileModelSelect({
  profileId,
  value,
  onChange,
  disabled,
}: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ProfileModel[]>([]);
  const [loading, setLoading] = useState(false);
  // Distinguish "fetch failed" from "no API key configured" — both result
  // in an empty `models` array, but the user should see different UX.
  // Fetch error: actionable ("check the API key / try again").
  // No API key: status quo ("save the profile first").
  const [fetchError, setFetchError] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!profileId) {
      setModels([]);
      setFetchError(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setFetchError(false);
    fetchProfileModels(profileId)
      .then((res) => {
        if (!cancelled) setModels(res.models ?? []);
      })
      .catch(() => {
        if (!cancelled) {
          setModels([]);
          setFetchError(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Trigger label: live model's display_name when matched; legacy alias
  // label when the stored value is a family alias; raw id otherwise.
  function labelFor(v: string): string {
    if (v === "") return "Default";
    if (LEGACY_ALIAS_LABEL[v]) return LEGACY_ALIAS_LABEL[v];
    const live = models.find((m) => m.id === v);
    return live?.display_name ?? v;
  }

  // If the stored value isn't in the live list and isn't empty, surface it as
  // a "(legacy)" entry at the top of the model list so the user sees what's
  // actually stored before they re-pick. Avoids the silent-coercion case.
  const valueInList = value === "" || models.some((m) => m.id === value);
  const legacyEntry = !valueInList ? value : null;

  return (
    <div className="vz-select" ref={ref} data-disabled={disabled ? "true" : undefined}>
      <button
        type="button"
        className="vz-select__trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
      >
        <span style={{ color: "var(--vz-ink)" }}>{labelFor(value)}</span>
        <Icon.chevron />
      </button>
      {open && (
        <div
          className="vz-menu"
          style={{
            top: "calc(100% + 4px)",
            left: 0,
            right: 0,
            maxHeight: "min(60vh, 360px)",
            overflowY: "auto",
            padding: 4,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* "Default" — let the SDK pick whatever it considers current. */}
          <div
            role="option"
            aria-selected={value === ""}
            className={`vz-menu__item ${value === "" ? "vz-menu__item--active" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onChange("");
              setOpen(false);
            }}
            style={{ alignItems: "center", justifyContent: "space-between", gap: 8 }}
          >
            <span>Default</span>
            <span
              style={{
                fontFamily: "var(--vz-font-mono)",
                fontSize: 11,
                color: "var(--vz-muted-2)",
              }}
            >
              SDK chooses
            </span>
          </div>

          {(legacyEntry || models.length > 0 || loading) && <div className="vz-menu__sep" />}

          {/* Legacy/unknown stored value — keeps it pickable for safety. */}
          {legacyEntry && (
            <div
              role="option"
              aria-selected
              className="vz-menu__item vz-menu__item--active"
              onMouseDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setOpen(false);
              }}
            >
              <span style={{ flex: 1 }}>{labelFor(legacyEntry)}</span>
              <span
                style={{
                  fontFamily: "var(--vz-font-mono)",
                  fontSize: 11,
                  color: "var(--vz-muted-2)",
                }}
              >
                {legacyEntry}
              </span>
            </div>
          )}

          {/* Live model list. Each row is name on top, raw id underneath in mono. */}
          {loading && models.length === 0 ? (
            <div
              style={{
                padding: "10px 12px",
                fontSize: 12,
                color: "var(--vz-muted-2)",
              }}
            >
              Loading models…
            </div>
          ) : models.length === 0 && !profileId ? (
            <div
              style={{
                padding: "10px 12px",
                fontSize: 12,
                color: "var(--vz-muted-2)",
                lineHeight: 1.5,
              }}
            >
              Specific versions become available after you save this profile
              (we need its API key to fetch the live list).
            </div>
          ) : models.length === 0 ? (
            <div
              style={{
                padding: "10px 12px",
                fontSize: 12,
                color: fetchError ? "var(--vz-fail)" : "var(--vz-muted-2)",
                lineHeight: 1.5,
              }}
            >
              {fetchError
                ? "Couldn't load models. The API key may be invalid or the provider unreachable."
                : "No models returned. The linked API key may have no model access yet."}
            </div>
          ) : (
            models.map((m) => (
              <div
                key={m.id}
                role="option"
                aria-selected={value === m.id}
                className={`vz-menu__item ${value === m.id ? "vz-menu__item--active" : ""}`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(m.id);
                  setOpen(false);
                }}
                style={{ flexDirection: "column", alignItems: "stretch", gap: 2, padding: "6px 10px" }}
              >
                <span style={{ fontSize: 13, color: "var(--vz-ink)" }}>
                  {m.display_name ?? m.id}
                </span>
                {m.display_name && m.display_name !== m.id && (
                  <span
                    style={{
                      fontFamily: "var(--vz-font-mono)",
                      fontSize: 11,
                      color: "var(--vz-muted-2)",
                    }}
                  >
                    {m.id}
                  </span>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
