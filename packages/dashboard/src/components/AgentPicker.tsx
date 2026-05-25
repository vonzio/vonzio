/**
 * AgentPicker — large searchable popover used in the workspace empty state
 * to pick a profile before the first message.
 *
 * Replaces the inline chip row because chips don't scale past ~5 profiles
 * (they wrap and turn into chip-soup). The popover surface is a sibling of
 * ModelPicker in style — same vz-menu shell, same search-at-top pattern,
 * same outside-click + Esc + ↑/↓/Enter keyboard handling — sized larger
 * because it lives in the hero, not the composer footer.
 *
 * The trigger looks like a chip but with a chevron, so the empty state
 * still reads as "a list of choices" rather than "a complex form."
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Icon } from "../brand/components.js";
import type { ProfileSummary } from "../api/client.js";

interface Props {
  profiles: ProfileSummary[];
  value: string | null;
  onChange: (id: string) => void;
}

function relativeTime(iso: string | undefined | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0 || Number.isNaN(ms)) return "—";
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "now";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  return `${mo}mo`;
}

export function AgentPicker({ profiles, value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hover, setHover] = useState(0);
  const ref = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);

  const current = profiles.find((p) => p.id === value) ?? profiles[0];

  // Sort: most-recently-used first, fall back to alphabetical. The "default"
  // profile is freshly created and has no last_used_at — alphabetical keeps
  // it stably above an empty-tail profile rather than scrambling on render.
  const sorted = useMemo(() => {
    return [...profiles].sort((a, b) => {
      const at = a.last_used_at ? new Date(a.last_used_at).getTime() : 0;
      const bt = b.last_used_at ? new Date(b.last_used_at).getTime() : 0;
      if (at !== bt) return bt - at;
      return a.name.localeCompare(b.name);
    });
  }, [profiles]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return sorted;
    return sorted.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        (p.model?.toLowerCase().includes(q) ?? false),
    );
  }, [sorted, query]);

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Focus search on open; reset on close.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => searchRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    setQuery("");
    setHover(0);
  }, [open]);

  // Keep hover index inside the filtered range as user types.
  useEffect(() => {
    if (hover >= filtered.length) setHover(Math.max(0, filtered.length - 1));
  }, [filtered.length, hover]);

  function onKey(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Escape") {
      e.preventDefault();
      setOpen(false);
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setHover((h) => Math.min(h + 1, Math.max(0, filtered.length - 1)));
      return;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setHover((h) => Math.max(0, h - 1));
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault();
      const pick = filtered[hover];
      if (pick) {
        onChange(pick.id);
        setOpen(false);
      }
    }
  }

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-block" }}>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 10,
          padding: "8px 14px 8px 16px",
          minWidth: 220,
          borderRadius: 999,
          background: "var(--vz-card)",
          border: "1px solid var(--vz-border)",
          color: "var(--vz-ink)",
          fontFamily: "var(--vz-font-sans)",
          fontSize: 13,
          fontWeight: 500,
          cursor: "pointer",
          transition: "border-color var(--vz-fast) var(--vz-ease), background var(--vz-fast) var(--vz-ease)",
          boxShadow: "var(--vz-shadow-sm)",
        }}
        onMouseEnter={(e) => {
          e.currentTarget.style.borderColor = "var(--vz-border-strong)";
        }}
        onMouseLeave={(e) => {
          e.currentTarget.style.borderColor = "var(--vz-border)";
        }}
      >
        <span
          style={{
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            letterSpacing: "0.08em",
            color: "var(--vz-muted-2)",
            textTransform: "uppercase",
          }}
        >
          Agent
        </span>
        <span
          style={{
            flex: 1,
            textAlign: "left",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            minWidth: 0,
          }}
        >
          {current?.name ?? "Choose…"}
        </span>
        <Icon.chevron width="12" height="12" />
      </button>

      {open && (
        <div
          className="vz-menu"
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            left: "50%",
            transform: "translateX(-50%)",
            width: 360,
            maxWidth: "calc(100vw - 32px)",
            maxHeight: "min(60vh, 460px)",
            zIndex: 30,
            display: "flex",
            flexDirection: "column",
            padding: 0,
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          {/* Search header */}
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
              className="vz-input"
              placeholder="Search agents…"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHover(0);
              }}
              onKeyDown={onKey}
              style={{ width: "100%", fontSize: 13, padding: "6px 10px" }}
            />
          </div>

          {/* Options list */}
          <div style={{ flex: 1, overflowY: "auto", padding: 4 }}>
            {filtered.length === 0 ? (
              <div
                style={{
                  padding: "20px 12px",
                  textAlign: "center",
                  color: "var(--vz-muted-2)",
                  fontSize: 13,
                }}
              >
                No agents match
              </div>
            ) : (
              filtered.map((p, i) => {
                const selected = p.id === value;
                const isHover = i === hover;
                return (
                  <div
                    key={p.id}
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setHover(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onChange(p.id);
                      setOpen(false);
                    }}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 10px",
                      borderRadius: "var(--vz-radius-sm)",
                      cursor: "pointer",
                      background: isHover ? "var(--vz-mute)" : "transparent",
                      color: "var(--vz-ink)",
                      fontSize: 13,
                    }}
                  >
                    <span
                      style={{
                        flex: 1,
                        minWidth: 0,
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                        whiteSpace: "nowrap",
                        fontWeight: selected ? 600 : 500,
                        color: selected ? "var(--vz-sodium)" : "var(--vz-ink)",
                      }}
                    >
                      {p.name}
                    </span>
                    {p.model && (
                      <span
                        style={{
                          fontFamily: "var(--vz-font-mono)",
                          fontSize: 11,
                          color: "var(--vz-muted-2)",
                          padding: "1px 6px",
                          borderRadius: "var(--vz-radius-sm)",
                          background: "var(--vz-mute)",
                          letterSpacing: "0.02em",
                          flexShrink: 0,
                        }}
                      >
                        {p.model}
                      </span>
                    )}
                    <span
                      style={{
                        fontFamily: "var(--vz-font-mono)",
                        fontSize: 10.5,
                        color: "var(--vz-muted)",
                        minWidth: 28,
                        textAlign: "right",
                        letterSpacing: "0.02em",
                        flexShrink: 0,
                      }}
                    >
                      {relativeTime(p.last_used_at)}
                    </span>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
