/**
 * ModelPicker — composer-footer pill that lets a user pick a per-workspace
 * model override. Loads available models from the active profile and falls
 * back to a hardcoded set when the endpoint is unreachable or empty.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchProfileModels, type ProfileModel } from "../api/client.js";
import { Icon } from "../brand/components.js";
import { MODEL_DISPLAY_FALLBACK } from "../lib/model-display.js";

interface Props {
  profileId: string;
  profileDefaultModel: string | null;
  value: string | null;
  onChange: (model: string | null) => void;
  disabled?: boolean;
}

// Keep ProfileModel-shaped fallbacks (with provider) so the dropdown renders
// even when the API is unreachable. Names come from the shared display map.
const FALLBACK_MODELS: ProfileModel[] = Object.entries(MODEL_DISPLAY_FALLBACK).map(
  ([id, display_name]) => ({ id, display_name, provider: "anthropic" as const }),
);

function displayFor(model: ProfileModel | undefined, id: string | null): string | null {
  if (!id) return null;
  if (model?.display_name) return model.display_name;
  if (model?.id) return model.id;
  return id;
}

export function ModelPicker({ profileId, profileDefaultModel, value, onChange, disabled }: Props) {
  const [models, setModels] = useState<ProfileModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Async-load models for the current profile.
  useEffect(() => {
    if (!profileId) {
      setModels([]);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetchProfileModels(profileId)
      .then((res) => {
        if (cancelled) return;
        if (res.models && res.models.length > 0) {
          setModels(res.models);
        } else {
          setModels(FALLBACK_MODELS);
        }
      })
      .catch(() => {
        if (!cancelled) setModels(FALLBACK_MODELS);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  // Close menu on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Auto-focus the search input when the menu opens; clear the query on close.
  useEffect(() => {
    if (open) {
      // Delay one tick so the input is in the DOM before we focus.
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  // Filter models by case-insensitive substring match against id + display name.
  // Memoized — re-running on every parent re-render is wasted work for a 30+
  // item Ollama list, even if cheap.
  const filteredModels = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return models;
    return models.filter(
      (m) => m.id.toLowerCase().includes(q) || (m.display_name?.toLowerCase().includes(q) ?? false),
    );
  }, [models, query]);

  // Resolve the active model: override > profile default > "default".
  const overrideModel = value ? models.find((m) => m.id === value) : undefined;
  const defaultModel = profileDefaultModel
    ? models.find((m) => m.id === profileDefaultModel)
    : undefined;
  const resolvedLabel =
    displayFor(overrideModel, value) ??
    displayFor(defaultModel, profileDefaultModel) ??
    "default";

  const overridden = !!value;
  const pillBg = overridden
    ? "color-mix(in srgb, var(--vz-sodium) 10%, transparent)"
    : "transparent";
  const pillColor = overridden ? "var(--vz-sodium)" : "var(--vz-muted-2)";
  const pillBorder = overridden
    ? "1px solid color-mix(in srgb, var(--vz-sodium) 30%, transparent)"
    : "1px solid transparent";

  if (loading && models.length === 0) {
    return (
      <span
        style={{
          fontFamily: "var(--vz-font-mono)",
          fontSize: 11.5,
          color: "var(--vz-muted-2)",
          letterSpacing: "0.02em",
          padding: "2px 8px",
        }}
      >
        loading…
      </span>
    );
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onMouseDown={(e) => {
          // Stop the document mousedown handler from racing with our state
          // update — without this, parents that reach for focus on click
          // can intercept and re-close the menu in the same event.
          if (!disabled) e.stopPropagation();
        }}
        onClick={(e) => {
          if (disabled) return;
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        disabled={disabled}
        title={overridden ? `Override: ${resolvedLabel}` : `Profile default: ${resolvedLabel}`}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          padding: "2px 8px",
          borderRadius: "var(--vz-radius-sm)",
          background: pillBg,
          border: pillBorder,
          color: pillColor,
          fontFamily: "var(--vz-font-mono)",
          fontSize: 11.5,
          fontWeight: 500,
          letterSpacing: "0.02em",
          cursor: disabled ? "not-allowed" : "pointer",
          opacity: disabled ? 0.6 : 1,
          transition: "background var(--vz-fast) var(--vz-ease), color var(--vz-fast) var(--vz-ease), border-color var(--vz-fast) var(--vz-ease)",
        }}
      >
        <span>{resolvedLabel}</span>
        <Icon.chevron width="11" height="11" />
      </button>
      {open && (
        <div
          className="vz-menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            left: 0,
            minWidth: 240,
            maxWidth: 320,
            // Cap height so long lists (Ollama can return 30+ models) don't
            // run off the top of the viewport. The footer + search bar stay
            // fixed; only the option list scrolls.
            maxHeight: "min(60vh, 420px)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            padding: 0,
          }}
          // Same belt-and-suspenders pattern as the brand Select primitive.
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Search filter — focused on open. Esc closes the menu. */}
          <div
            style={{
              padding: "8px 8px 6px",
              borderBottom: "1px solid var(--vz-border)",
              flexShrink: 0,
            }}
          >
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && filteredModels.length > 0) {
                  e.preventDefault();
                  onChange(filteredModels[0].id);
                  setOpen(false);
                }
              }}
              placeholder="search models…"
              className="vz-question-input"
              style={{
                width: "100%",
                background: "var(--vz-mute)",
                border: "1px solid var(--vz-border)",
                borderRadius: "var(--vz-radius-sm)",
                padding: "6px 10px",
                fontFamily: "var(--vz-font-mono)",
                fontSize: 12,
                color: "var(--vz-ink-2)",
                outline: "none",
              }}
            />
          </div>

          {/* Scrollable option list */}
          <div
            style={{
              overflowY: "auto",
              flex: 1,
              padding: 6,
              display: "flex",
              flexDirection: "column",
              gap: 1,
            }}
          >
            {filteredModels.length === 0 ? (
              <div
                className="vz-menu__item"
                style={{ color: "var(--vz-muted-2)", cursor: "default" }}
              >
                {models.length === 0 ? "no models available" : "no match"}
              </div>
            ) : (
              filteredModels.map((m) => {
                const isActive = value === m.id;
                const isProfileDefault = !value && profileDefaultModel === m.id;
                const label = m.display_name ?? m.id;
                return (
                  <div
                    key={m.id}
                    role="option"
                    aria-selected={isActive}
                    className={`vz-menu__item ${isActive ? "vz-menu__item--active" : ""}`}
                    // Pick on mousedown so selection commits before any blur/click
                    // race; close synchronously inside the same event.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onChange(m.id);
                      setOpen(false);
                    }}
                    style={{ display: "flex", alignItems: "center", gap: 8 }}
                  >
                    <span style={{ flex: 1 }}>{label}</span>
                    {isProfileDefault && (
                      <span
                        style={{
                          fontFamily: "var(--vz-font-mono)",
                          fontSize: 10,
                          color: "var(--vz-muted-2)",
                          letterSpacing: "0.04em",
                        }}
                      >
                        default
                      </span>
                    )}
                  </div>
                );
              })
            )}
          </div>

          {/* Footer: reset action stays pinned outside the scroll area */}
          {overridden && (
            <div
              style={{
                borderTop: "1px solid var(--vz-border)",
                padding: 6,
                flexShrink: 0,
              }}
            >
              <div
                role="option"
                className="vz-menu__item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(null);
                  setOpen(false);
                }}
                style={{
                  color: "var(--vz-muted-2)",
                  fontFamily: "var(--vz-font-mono)",
                  fontSize: 11,
                  letterSpacing: "0.04em",
                  padding: "6px 10px",
                }}
              >
                Reset to profile default
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
