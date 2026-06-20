/**
 * ModelPicker — composer-footer pill for the per-conversation model.
 *
 * Lists every model the user can reach, grouped by API key/provider (not just
 * the agent's attached key), so a workspace can switch provider mid-chat. A
 * selection reports both the model and the key it came from; picking a model
 * from a key other than the profile's sets a per-conversation key override.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchAllUserModels, type ProfileModel, type KeyModelGroup } from "../api/client.js";
import { Icon } from "../brand/components.js";
import { MODEL_DISPLAY_FALLBACK } from "../lib/model-display.js";

interface Props {
  /** The profile's attached key — selecting a model from it clears the override. */
  profileApiKeyId: string | null;
  profileDefaultModel: string | null;
  /** Current per-conversation model override (null = profile default). */
  value: string | null;
  /** Current per-conversation key override (null = profile's key). */
  apiKeyIdOverride: string | null;
  /** (model, apiKeyId) — apiKeyId is null when the model belongs to the profile's key. */
  onChange: (model: string | null, apiKeyId: string | null) => void;
  disabled?: boolean;
}

const FALLBACK_MODELS: ProfileModel[] = Object.entries(MODEL_DISPLAY_FALLBACK).map(
  ([id, display_name]) => ({ id, display_name, provider: "anthropic" as const }),
);

export function ModelPicker({ profileApiKeyId, profileDefaultModel, value, apiKeyIdOverride, onChange, disabled }: Props) {
  const [groups, setGroups] = useState<KeyModelGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  // Load models across all of the user's keys. Degrade to a hardcoded set
  // ONLY when the profile already has a key attached and the endpoint is
  // unreachable/empty (transient) — so a keyed user isn't stranded. A profile
  // with NO key attached shows the honest empty state instead of a fallback
  // list that would falsely imply platform models are available.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const fallback: KeyModelGroup[] = profileApiKeyId
      ? [{ key_id: profileApiKeyId, key_name: "Models", provider: "anthropic", models: FALLBACK_MODELS }]
      : [];
    fetchAllUserModels()
      .then((res) => {
        if (cancelled) return;
        const withModels = (res.keys ?? []).filter((g) => g.models.length > 0);
        setGroups(withModels.length > 0 ? withModels : fallback);
      })
      .catch(() => {
        if (!cancelled) setGroups(fallback);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileApiKeyId]);

  // Close menu on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Auto-focus search on open; clear query on close.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery("");
  }, [open]);

  // Filter within each group; drop groups with no matches.
  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groups;
    return groups
      .map((g) => ({
        ...g,
        models: g.models.filter(
          (m) => m.id.toLowerCase().includes(q) || (m.display_name?.toLowerCase().includes(q) ?? false),
        ),
      }))
      .filter((g) => g.models.length > 0);
  }, [groups, query]);

  // The key whose model is currently effective (override, else profile's).
  const effectiveKeyId = apiKeyIdOverride ?? profileApiKeyId;
  const allModels = useMemo(() => groups.flatMap((g) => g.models), [groups]);
  const currentModel = value ? allModels.find((m) => m.id === value) : undefined;
  const defaultModel = profileDefaultModel ? allModels.find((m) => m.id === profileDefaultModel) : undefined;
  const resolvedLabel =
    (value ? currentModel?.display_name ?? value : defaultModel?.display_name ?? profileDefaultModel) ?? "default";

  const overridden = !!value || !!apiKeyIdOverride;
  const pillBg = overridden ? "color-mix(in srgb, var(--vz-sodium) 10%, transparent)" : "transparent";
  const pillColor = overridden ? "var(--vz-sodium)" : "var(--vz-muted-2)";
  const pillBorder = overridden
    ? "1px solid color-mix(in srgb, var(--vz-sodium) 30%, transparent)"
    : "1px solid transparent";

  const showHeaders = groups.length > 1;
  const totalFiltered = filteredGroups.reduce((n, g) => n + g.models.length, 0);
  const firstMatch = filteredGroups.find((g) => g.models.length > 0)?.models[0];
  const firstMatchGroup = filteredGroups.find((g) => g.models.length > 0);
  // The override to persist for a group: null when it's the profile's own key
  // (no override) OR an empty fallback id, so we never store a junk "" override.
  const overrideKeyFor = (keyId: string): string | null =>
    keyId && keyId !== profileApiKeyId ? keyId : null;

  if (loading && groups.length === 0) {
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
            maxWidth: 340,
            maxHeight: "min(60vh, 420px)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            padding: 0,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div style={{ padding: "8px 8px 6px", borderBottom: "1px solid var(--vz-border)", flexShrink: 0 }}>
            <input
              ref={searchRef}
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.preventDefault();
                  setOpen(false);
                } else if (e.key === "Enter" && firstMatch && firstMatchGroup) {
                  e.preventDefault();
                  onChange(firstMatch.id, overrideKeyFor(firstMatchGroup.key_id));
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

          <div style={{ overflowY: "auto", flex: 1, padding: 6, display: "flex", flexDirection: "column", gap: 1 }}>
            {totalFiltered === 0 ? (
              <div className="vz-menu__item" style={{ color: "var(--vz-muted-2)", cursor: "default" }}>
                {allModels.length === 0 ? "no models available" : "no match"}
              </div>
            ) : (
              filteredGroups.map((g) => (
                <div key={`${g.key_id || "profile"}:${g.provider}`} style={{ display: "flex", flexDirection: "column", gap: 1 }}>
                  {showHeaders && (
                    <div
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: 6,
                        padding: "6px 10px 3px",
                        fontFamily: "var(--vz-font-mono)",
                        fontSize: 10,
                        letterSpacing: "0.06em",
                        textTransform: "uppercase",
                        color: "var(--vz-muted-2)",
                      }}
                    >
                      <span style={{ fontWeight: 600, color: "var(--vz-muted)" }}>{g.key_name}</span>
                      <span style={{ opacity: 0.6 }}>· {g.provider}</span>
                    </div>
                  )}
                  {g.models.map((m) => {
                    const isActive = value === m.id && g.key_id === effectiveKeyId;
                    const isProfileDefault = !value && profileDefaultModel === m.id && g.key_id === profileApiKeyId;
                    const label = m.display_name ?? m.id;
                    return (
                      <div
                        key={`${g.key_id}:${m.id}`}
                        role="option"
                        aria-selected={isActive}
                        className={`vz-menu__item ${isActive ? "vz-menu__item--active" : ""}`}
                        onMouseDown={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          onChange(m.id, overrideKeyFor(g.key_id));
                          setOpen(false);
                        }}
                        style={{ display: "flex", alignItems: "center", gap: 8 }}
                      >
                        <span style={{ flex: 1 }}>{label}</span>
                        {isProfileDefault && (
                          <span style={{ fontFamily: "var(--vz-font-mono)", fontSize: 10, color: "var(--vz-muted-2)", letterSpacing: "0.04em" }}>
                            default
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              ))
            )}
          </div>

          {overridden && (
            <div style={{ borderTop: "1px solid var(--vz-border)", padding: 6, flexShrink: 0 }}>
              <div
                role="option"
                className="vz-menu__item"
                onMouseDown={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  onChange(null, null);
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
