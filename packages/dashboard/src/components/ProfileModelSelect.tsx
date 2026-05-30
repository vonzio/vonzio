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
  /**
   * Optional override for how the live model list is fetched. SaaS
   * surfaces (org-agent editor) pass a fetcher that hits
   * `/api/orgs/:slug/profiles/:id/models` instead of the default
   * `/v1/profiles/:id/models`. Default = fetchProfileModels.
   */
  fetcher?: (profileId: string) => Promise<{ models: ProfileModel[] }>;
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
  fetcher,
}: Props) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<ProfileModel[]>([]);
  const [loading, setLoading] = useState(false);
  // Distinguish "fetch failed" from "no API key configured" — both result
  // in an empty `models` array, but the user should see different UX.
  // Fetch error: actionable ("check the API key / try again").
  // No API key: status quo ("save the profile first").
  const [fetchError, setFetchError] = useState(false);
  // Substring filter for the live list. Cleared on close so re-opening
  // is always a fresh search. Matches on id OR display_name (case
  // insensitive) so users typing "opus" find Claude Opus regardless of
  // version suffix.
  const [filter, setFilter] = useState("");
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
    const doFetch = fetcher ?? fetchProfileModels;
    doFetch(profileId)
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

  // Reset the filter every time the menu closes so re-opening starts
  // fresh — typing "opus" then closing should NOT leave "opus" filling
  // the search box on next open.
  useEffect(() => {
    if (!open) setFilter("");
  }, [open]);

  // Trigger label: live model's display_name when matched; legacy alias
  // label when the stored value is a family alias; raw id otherwise.
  // Empty value shows as a placeholder — the editor must guard save
  // until the user picks (Claude Code's SDK can invent phantom model
  // ids like "claude-opus-4-7[1m]" when left to pick its own default,
  // breaking the agent at run time).
  function labelFor(v: string): string {
    if (v === "") return "Pick a model…";
    if (LEGACY_ALIAS_LABEL[v]) return LEGACY_ALIAS_LABEL[v];
    const live = models.find((m) => m.id === v);
    return live?.display_name ?? v;
  }

  // If the stored value isn't in the live list and isn't empty, surface it as
  // a "(legacy)" entry at the top of the model list so the user sees what's
  // actually stored before they re-pick. Avoids the silent-coercion case.
  const valueInList = value === "" || models.some((m) => m.id === value);
  const legacyEntry = !valueInList ? value : null;

  // Filtered model list — substring match on both the id and the
  // human display name so users can type "opus" or "claude-3" and
  // find what they want. Empty filter = full list.
  const needle = filter.trim().toLowerCase();
  const filteredModels = needle === ""
    ? models
    : models.filter(
        (m) =>
          m.id.toLowerCase().includes(needle) ||
          (m.display_name?.toLowerCase().includes(needle) ?? false),
      );

  return (
    <div className="vz-select" ref={ref} data-disabled={disabled ? "true" : undefined}>
      <button
        type="button"
        className="vz-select__trigger"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
      >
        <span style={{ color: value === "" ? "var(--vz-muted-2)" : "var(--vz-ink)" }}>
          {labelFor(value)}
        </span>
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
          {/* Search box — only shown once there's a meaningful number
              of models to filter (no point with 0-1 results). */}
          {models.length > 3 && (
            <div
              style={{
                position: "sticky",
                top: 0,
                background: "var(--vz-surface)",
                paddingBottom: 4,
                marginBottom: 4,
                borderBottom: "1px solid var(--vz-border)",
                zIndex: 1,
              }}
              onMouseDown={(e) => e.stopPropagation()}
            >
              <input
                type="text"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Filter models…"
                autoFocus
                style={{
                  width: "100%",
                  padding: "6px 10px",
                  fontSize: 12,
                  fontFamily: "var(--vz-font-mono)",
                  background: "var(--vz-surface-2)",
                  border: "1px solid var(--vz-border)",
                  borderRadius: 4,
                  color: "var(--vz-ink)",
                  outline: "none",
                  boxSizing: "border-box",
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setFilter("");
                    setOpen(false);
                  }
                }}
              />
            </div>
          )}

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
          ) : filteredModels.length === 0 ? (
            <div
              style={{
                padding: "10px 12px",
                fontSize: 12,
                color: "var(--vz-muted-2)",
                lineHeight: 1.5,
              }}
            >
              No models match “{filter}”.
            </div>
          ) : (
            filteredModels.map((m) => (
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
