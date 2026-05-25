/**
 * ToolPillSelect — unified toggle-chip grid for picking the allowed-tools
 * list on a profile.
 *
 * Previous version had three rendering modes on the same surface (flat
 * names in core, flat names behind a disclosure in advanced, purple
 * pills for custom tools) — the selected state lived only at the
 * bottom, disconnected from the picker. Now: one chip per tool, one
 * selected state (sodium fill), one source of truth.
 *
 * Layout:
 *   - Header row: count + bulk actions (Select all / Clear / Core only)
 *   - Search input that filters chips across all categories live
 *   - Tools grouped by semantic category (File I/O, Web, Plan…) so a
 *     38-tool list reads as ~10 small clusters instead of one wall
 *   - Custom category at the bottom for anything not in the built-in
 *     list (e.g. MCP-server-provided tools), with an add input
 *
 * Props are unchanged from the old shape so the caller (MyAgents) needs
 * no edits.
 */
import { useMemo, useState } from "react";
import { X } from "lucide-react";

interface ToolDef {
  name: string;
  description: string;
}

// Categorized tool catalogue. Order within each group is intentional —
// most-used first inside each. Categories themselves are ordered by
// expected frequency (file I/O first, system internals last).
const CATEGORIES: { label: string; tools: ToolDef[] }[] = [
  {
    label: "File I/O",
    tools: [
      { name: "Read", description: "Read files from the filesystem" },
      { name: "Edit", description: "Make targeted edits to existing files" },
      { name: "Write", description: "Create or overwrite files" },
      { name: "NotebookEdit", description: "Edit Jupyter notebooks" },
      { name: "Grep", description: "Search file contents with regex" },
      { name: "Glob", description: "Find files by pattern" },
    ],
  },
  {
    label: "Shell",
    tools: [
      { name: "Bash", description: "Run shell commands" },
    ],
  },
  {
    label: "Web",
    tools: [
      { name: "WebFetch", description: "Fetch content from URLs" },
      { name: "WebSearch", description: "Search the web" },
    ],
  },
  {
    label: "Delegation",
    tools: [
      { name: "Agent", description: "Spawn specialized subagents" },
      { name: "Skill", description: "Invoke user-defined skills" },
      { name: "ToolSearch", description: "Load deferred tool schemas" },
    ],
  },
  {
    label: "Plan",
    tools: [
      { name: "EnterPlanMode", description: "Enter planning mode" },
      { name: "ExitPlanMode", description: "Exit planning mode" },
      { name: "TodoWrite", description: "Manage task/todo lists" },
      { name: "AskUserQuestion", description: "Ask the user a question with options" },
    ],
  },
  {
    label: "Tasks",
    tools: [
      { name: "TaskCreate", description: "Create a background task" },
      { name: "TaskGet", description: "Get task status and output" },
      { name: "TaskList", description: "List all tasks" },
      { name: "TaskUpdate", description: "Update a task" },
      { name: "TaskOutput", description: "Get task output" },
      { name: "TaskStop", description: "Stop a running task" },
    ],
  },
  {
    label: "Worktree",
    tools: [
      { name: "EnterWorktree", description: "Create an isolated git worktree" },
      { name: "ExitWorktree", description: "Exit and clean up worktree" },
    ],
  },
  {
    label: "Cron",
    tools: [
      { name: "CronCreate", description: "Create a scheduled task" },
      { name: "CronDelete", description: "Delete a scheduled task" },
      { name: "CronList", description: "List scheduled tasks" },
    ],
  },
  {
    label: "MCP",
    tools: [
      { name: "Mcp", description: "Call an MCP tool directly" },
      { name: "ListMcpResources", description: "List MCP server resources" },
      { name: "ReadMcpResource", description: "Read a specific MCP resource" },
    ],
  },
  {
    label: "System",
    tools: [
      { name: "Config", description: "Read/write Claude Code configuration" },
      { name: "Monitor", description: "Monitor file or process changes" },
      { name: "LSP", description: "Language Server Protocol operations" },
      { name: "SendUserMessage", description: "Send a message to the user (brief mode)" },
    ],
  },
];

// "Core" subset — what `Core only` resets to. Matches the old behaviour:
// File I/O + Shell + Web + Delegation. Plan/Tasks/Worktree/Cron/MCP/System
// are opt-in.
const CORE_CATEGORY_LABELS = new Set(["File I/O", "Shell", "Web", "Delegation"]);

const ALL_TOOLS: ToolDef[] = CATEGORIES.flatMap((c) => c.tools);
const ALL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));
const CORE_NAMES = CATEGORIES
  .filter((c) => CORE_CATEGORY_LABELS.has(c.label))
  .flatMap((c) => c.tools.map((t) => t.name));

interface Props {
  label?: string;
  hint?: string;
  value: string[];
  onChange: (tools: string[]) => void;
}

export function ToolPillSelect({ label, hint, value, onChange }: Props) {
  const [query, setQuery] = useState("");
  const [customInput, setCustomInput] = useState("");

  const valueSet = useMemo(() => new Set(value), [value]);
  const customTools = useMemo(
    () => value.filter((t) => !ALL_NAMES.has(t)),
    [value],
  );

  // Filtered view: search query narrows the visible chip set across all
  // categories. Empty categories disappear. Built-ins use name OR
  // description, so "test" matches anything test-adjacent.
  const filteredCategories = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return CATEGORIES;
    return CATEGORIES
      .map((c) => ({
        label: c.label,
        tools: c.tools.filter(
          (t) =>
            t.name.toLowerCase().includes(q) ||
            t.description.toLowerCase().includes(q),
        ),
      }))
      .filter((c) => c.tools.length > 0);
  }, [query]);

  const matchingCustom = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return customTools;
    return customTools.filter((t) => t.toLowerCase().includes(q));
  }, [customTools, query]);

  function toggle(name: string) {
    if (valueSet.has(name)) onChange(value.filter((t) => t !== name));
    else onChange([...value, name]);
  }

  function selectAll() {
    onChange([...Array.from(ALL_NAMES), ...customTools]);
  }
  function clearAll() {
    onChange([]);
  }
  function coreOnly() {
    onChange([...CORE_NAMES, ...customTools]);
  }

  function addCustom() {
    const trimmed = customInput.trim();
    if (!trimmed) return;
    if (!valueSet.has(trimmed)) onChange([...value, trimmed]);
    setCustomInput("");
  }

  const totalCount = ALL_TOOLS.length + customTools.length;

  return (
    <div>
      {label && (
        <label
          style={{
            display: "block",
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            letterSpacing: "0.14em",
            textTransform: "uppercase",
            color: "var(--vz-muted-2)",
            marginBottom: 8,
          }}
        >
          {label}
        </label>
      )}

      {/* Header: count + bulk actions + search */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          flexWrap: "wrap",
          marginBottom: 10,
        }}
      >
        <span
          style={{
            fontFamily: "var(--vz-font-mono)",
            fontSize: 11,
            letterSpacing: "0.04em",
            color: "var(--vz-sodium)",
            fontWeight: 500,
          }}
        >
          {value.length} of {totalCount} selected
        </span>
        <BulkAction onClick={selectAll}>Select all</BulkAction>
        <BulkAction onClick={clearAll}>Clear</BulkAction>
        <BulkAction onClick={coreOnly}>Core only</BulkAction>
        <input
          type="text"
          className="vz-input"
          placeholder="Search tools…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ marginLeft: "auto", width: 180, fontSize: 12, padding: "5px 10px" }}
        />
      </div>

      {/* Categorized chip grid */}
      <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        {filteredCategories.map((cat) => (
          <div key={cat.label}>
            <div
              style={{
                fontFamily: "var(--vz-font-mono)",
                fontSize: 10,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--vz-muted-2)",
                marginBottom: 6,
              }}
            >
              {cat.label}
            </div>
            <div className="vz-chip-row">
              {cat.tools.map((t) => {
                const selected = valueSet.has(t.name);
                return (
                  <button
                    key={t.name}
                    type="button"
                    title={t.description}
                    onClick={() => toggle(t.name)}
                    className="vz-chip"
                    data-active={selected ? "true" : undefined}
                    style={{ cursor: "pointer", fontFamily: "var(--vz-font-sans)", fontSize: 12 }}
                  >
                    {selected && (
                      <span style={{ fontSize: 10, opacity: 0.7 }}>✓</span>
                    )}
                    {t.name}
                  </button>
                );
              })}
            </div>
          </div>
        ))}

        {/* Custom tools — anything in `value` not in the built-in catalogue.
            Lives at the bottom whether or not it has results during search,
            so user can always reach the add input. */}
        {(matchingCustom.length > 0 || !query) && (
          <div>
            <div
              style={{
                fontFamily: "var(--vz-font-mono)",
                fontSize: 10,
                letterSpacing: "0.16em",
                textTransform: "uppercase",
                color: "var(--vz-muted-2)",
                marginBottom: 6,
              }}
            >
              Custom
            </div>
            <div className="vz-chip-row">
              {matchingCustom.map((name) => (
                <span
                  key={name}
                  className="vz-chip"
                  data-active="true"
                  style={{ fontFamily: "var(--vz-font-mono)", fontSize: 11.5, gap: 6 }}
                >
                  {name}
                  <button
                    type="button"
                    onClick={() => toggle(name)}
                    title={`Remove ${name}`}
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      background: "transparent",
                      border: 0,
                      cursor: "pointer",
                      color: "inherit",
                      padding: 0,
                      lineHeight: 0,
                      opacity: 0.7,
                    }}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {!query && (
                <input
                  type="text"
                  className="vz-input"
                  placeholder="+ add custom tool name…"
                  value={customInput}
                  onChange={(e) => setCustomInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addCustom();
                    }
                  }}
                  onBlur={addCustom}
                  style={{
                    flex: "1 1 200px",
                    minWidth: 180,
                    maxWidth: 280,
                    fontSize: 12,
                    padding: "4px 10px",
                  }}
                />
              )}
            </div>
          </div>
        )}
      </div>

      {hint && (
        <p
          style={{
            fontSize: 12,
            color: "var(--vz-muted-2)",
            marginTop: 10,
            fontFamily: "var(--vz-font-mono)",
            letterSpacing: "0.02em",
          }}
        >
          {hint}
        </p>
      )}
      {value.length === 0 && (
        <p
          style={{
            fontSize: 12,
            color: "var(--vz-muted)",
            marginTop: 6,
            fontFamily: "var(--vz-font-mono)",
          }}
        >
          Empty = all tools allowed.
        </p>
      )}
    </div>
  );
}

function BulkAction({ children, onClick }: { children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        background: "transparent",
        border: 0,
        padding: 0,
        cursor: "pointer",
        fontFamily: "var(--vz-font-mono)",
        fontSize: 10.5,
        letterSpacing: "0.08em",
        textTransform: "uppercase",
        color: "var(--vz-muted)",
        transition: "color var(--vz-fast) var(--vz-ease)",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.color = "var(--vz-ink-3)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.color = "var(--vz-muted)";
      }}
    >
      {children}
    </button>
  );
}
