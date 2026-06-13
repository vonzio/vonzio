import { useState } from "react";
import { Plus, X } from "lucide-react";
import { TerminalPane } from "./TerminalPane.js";

interface Term { id: string; label: string }

let seq = 0;
const newTerm = (): Term => {
  seq += 1;
  // Stable, collision-free id; the label is just the running count.
  return { id: `t${seq}-${Math.random().toString(36).slice(2, 8)}`, label: String(seq) };
};

/**
 * Multi-terminal console (VS Code style). Each tab is an independent PTY on
 * the workspace container, so you can run a service in one and work in
 * another. Every pane stays MOUNTED for the lifetime of this component —
 * RightPanel keeps the manager mounted across tab switches, so shells (and
 * whatever runs in them) survive leaving and returning to the Console.
 *
 * `active` = the Console tab is the visible RightPanel tab. Only the active
 * terminal of an active console is shown; the rest stay alive, hidden.
 */
export function TerminalTab({
  workspaceId,
  containerId,
  active,
}: {
  workspaceId: string;
  containerId: string | null;
  active: boolean;
}) {
  const [terms, setTerms] = useState<Term[]>(() => [newTerm()]);
  const [activeId, setActiveId] = useState<string>(() => terms[0]?.id ?? "");

  const addTerm = () => {
    const t = newTerm();
    setTerms((prev) => [...prev, t]);
    setActiveId(t.id);
  };

  const closeTerm = (id: string) => {
    setTerms((prev) => {
      const idx = prev.findIndex((t) => t.id === id);
      const next = prev.filter((t) => t.id !== id);
      if (id === activeId) {
        const fallback = next[idx] ?? next[idx - 1] ?? next[0];
        setActiveId(fallback?.id ?? "");
      }
      return next;
    });
  };

  if (!containerId) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--vz-muted-2)" }}>
        No container running
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col" style={{ background: "#0a0a0a" }}>
      {/* Terminal tab strip */}
      <div
        className="flex items-center gap-1 px-2 shrink-0 overflow-x-auto"
        style={{ height: 32, borderBottom: "1px solid var(--vz-border)", background: "var(--vz-card)" }}
      >
        {terms.map((t) => {
          const isActive = t.id === activeId;
          return (
            <div
              key={t.id}
              role="tab"
              onClick={() => setActiveId(t.id)}
              className="group flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
              style={{
                height: 24, padding: "0 8px", borderRadius: 5, fontSize: 12,
                fontFamily: "var(--vz-font-mono)",
                color: isActive ? "var(--vz-ink)" : "var(--vz-muted)",
                background: isActive ? "var(--vz-mute)" : "transparent",
                border: `1px solid ${isActive ? "var(--vz-border)" : "transparent"}`,
              }}
            >
              <span>{`Terminal ${t.label}`}</span>
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); closeTerm(t.id); }}
                className={isActive ? "" : "opacity-0 group-hover:opacity-100"}
                style={{ display: "inline-flex", color: "var(--vz-muted-2)", transition: "opacity var(--vz-fast) var(--vz-ease)" }}
                title="Close terminal"
                aria-label={`Close terminal ${t.label}`}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={addTerm}
          className="vz-action-btn shrink-0"
          style={{ width: 24, height: 24, marginLeft: 2 }}
          title="New terminal"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Panes — all mounted; only the active one (in an active console) shows. */}
      <div className="flex-1 min-h-0 relative">
        {terms.length === 0 ? (
          <button
            type="button"
            onClick={addTerm}
            className="absolute inset-0 flex items-center justify-center text-sm"
            style={{ color: "var(--vz-muted-2)" }}
          >
            + New terminal
          </button>
        ) : (
          terms.map((t) => (
            <div key={t.id} className="absolute inset-0" style={{ pointerEvents: active && t.id === activeId ? "auto" : "none" }}>
              <TerminalPane
                workspaceId={workspaceId}
                terminalId={t.id}
                visible={active && t.id === activeId}
                onExit={() => closeTerm(t.id)}
              />
            </div>
          ))
        )}
      </div>
    </div>
  );
}
