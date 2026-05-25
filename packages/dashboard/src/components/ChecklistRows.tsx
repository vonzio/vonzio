/**
 * ChecklistRows — a vertical list of checkbox rows for selecting items by id.
 *
 * Used by the EditAgent page (subagents + skills pickers) and the inline
 * sections in MyAgents.tsx that show subagent/skill lists. The shape is
 * `Record<string, unknown>[]` instead of a typed item because the upstream
 * API returns loose JSON; rows are rendered from `id`, `name`, and
 * (optional) `description`.
 *
 * If empty, renders a single muted line with `emptyText` — let the caller
 * decide whether to nudge the user to create one elsewhere or via an
 * inline-create affordance.
 */
import type { ReactNode } from "react";

interface Props {
  items: Record<string, unknown>[];
  selectedIds: string[];
  onChange: (ids: string[]) => void;
  emptyText: ReactNode;
}

export function ChecklistRows({ items, selectedIds, onChange, emptyText }: Props) {
  if (!items.length) {
    return <span style={{ fontSize: 12, color: "var(--vz-muted-2)" }}>{emptyText}</span>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      {items.map((item) => {
        const id = item.id as string;
        const checked = selectedIds.includes(id);
        return (
          <label
            key={id}
            style={{
              display: "flex", alignItems: "center", gap: 8,
              padding: "6px 8px", borderRadius: "var(--vz-radius-sm)",
              cursor: "pointer",
              background: checked ? "var(--vz-mute)" : "transparent",
            }}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) => {
                onChange(e.target.checked ? [...selectedIds, id] : selectedIds.filter((x) => x !== id));
              }}
            />
            <span style={{ fontSize: 13, color: "var(--vz-ink)" }}>{item.name as string}</span>
            {item.description ? (
              <span style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>{item.description as string}</span>
            ) : null}
          </label>
        );
      })}
    </div>
  );
}
