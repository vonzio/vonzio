import { useState, useEffect, useRef, useCallback, type ChangeEvent } from "react";
import { Search as SearchIcon, X, Trash2, Pencil, Brain } from "lucide-react";
import {
  fetchMemories,
  searchMemories,
  updateMemory,
  deleteMemory,
  bulkDeleteMemories,
  type MemorySummary,
} from "../api/client.js";
import {
  PageHeader,
  PageBody,
  Button,
  Field,
  Input,
  Textarea,
  Select,
  Search,
  Pill,
  Card,
  Tabs,
  EmptyState,
  Modal,
  type SelectOption,
} from "../brand/components.js";
import { formatRelative } from "../lib/utils.js";

type MemoryType = MemorySummary["type"];

const typeTabs = [
  { value: "all", label: "All" },
  { value: "user", label: "User" },
  { value: "feedback", label: "Feedback" },
  { value: "project", label: "Project" },
  { value: "reference", label: "Reference" },
] as const;

const typeOptions: SelectOption[] = [
  { value: "user", label: "User" },
  { value: "feedback", label: "Feedback" },
  { value: "project", label: "Project" },
  { value: "reference", label: "Reference" },
];

// Map memory type → vz-pill tone. None of our brand tones map literally to
// "user / feedback / project / reference" — we pick the closest semantic
// (info for user, warn for feedback as 'guidance', ok for project as
// 'commitment', accent for reference as 'pointer').
const typeToTone: Record<MemoryType, "info" | "warn" | "ok" | "accent"> = {
  user: "info",
  feedback: "warn",
  project: "ok",
  reference: "accent",
};

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max) + "…";
}

export default function Memories() {
  const [memories, setMemories] = useState<MemorySummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [activeType, setActiveType] = useState<string>("all");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({
    name: "",
    type: "user" as MemoryType,
    description: "",
    body: "",
  });
  const [saving, setSaving] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [debouncedQuery, setDebouncedQuery] = useState("");

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedQuery(searchQuery), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [searchQuery]);

  const loadMemories = useCallback(async () => {
    setLoading(true);
    try {
      const typeParam = activeType === "all" ? undefined : activeType;
      const result = debouncedQuery.trim()
        ? await searchMemories({ q: debouncedQuery, type: typeParam })
        : await fetchMemories({ type: typeParam });
      setMemories(result);
    } catch {
      setMemories([]);
    } finally {
      setLoading(false);
    }
  }, [activeType, debouncedQuery]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  const startEdit = (mem: MemorySummary) => {
    setEditingId(mem.id);
    setEditForm({
      name: mem.name,
      type: mem.type,
      description: mem.description ?? "",
      body: mem.body,
    });
  };

  const cancelEdit = () => setEditingId(null);

  const saveEdit = async (id: string) => {
    setSaving(true);
    try {
      await updateMemory(id, {
        name: editForm.name,
        type: editForm.type,
        description: editForm.description || undefined,
        body: editForm.body,
      });
      setEditingId(null);
      loadMemories();
    } catch {
      /* silent */
    } finally {
      setSaving(false);
    }
  };

  const removeOne = async (id: string) => {
    if (!window.confirm("Delete this memory?")) return;
    try {
      await deleteMemory(id);
      loadMemories();
    } catch {
      /* silent */
    }
  };

  const removeBulk = async () => {
    const typeParam = activeType === "all" ? undefined : activeType;
    try {
      await bulkDeleteMemories({ type: typeParam });
      setBulkDeleteOpen(false);
      loadMemories();
    } catch {
      /* silent */
    }
  };

  const bulkLabel = activeType === "all" ? "all" : `all ${activeType}`;

  return (
    <>
      <PageHeader
        eyebrow="Memory"
        title="Persistent context"
        lede="Browse and manage what the agent remembers across runs."
        actions={
          memories.length > 0 ? (
            <Button
              variant="danger-ghost"
              size="sm"
              icon={<Trash2 size={14} />}
              onClick={() => setBulkDeleteOpen(true)}
            >
              Delete {bulkLabel}
            </Button>
          ) : undefined
        }
      />

      <PageBody>
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 16,
            alignItems: "center",
            marginBottom: 20,
          }}
        >
          <div style={{ flex: "1 1 280px", maxWidth: 480, position: "relative" }}>
            <Search
              placeholder="Search memories…"
              value={searchQuery}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setSearchQuery(e.target.value)}
            />
            {searchQuery && (
              <button
                type="button"
                onClick={() => setSearchQuery("")}
                aria-label="Clear search"
                style={{
                  position: "absolute",
                  right: 10,
                  top: "50%",
                  transform: "translateY(-50%)",
                  background: "none",
                  border: 0,
                  color: "var(--vz-muted-2)",
                  cursor: "pointer",
                  padding: 4,
                  display: "flex",
                }}
              >
                <X size={14} />
              </button>
            )}
          </div>
        </div>

        <Tabs
          tabs={typeTabs as unknown as { value: string; label: string }[]}
          value={activeType}
          onChange={setActiveType}
        />

        <div style={{ marginTop: 20 }}>
          {loading ? (
            <div
              style={{
                display: "flex",
                justifyContent: "center",
                padding: "48px 0",
                color: "var(--vz-muted)",
                fontSize: 13,
                fontFamily: "var(--vz-font-mono)",
              }}
            >
              loading…
            </div>
          ) : memories.length === 0 ? (
            <EmptyState
              icon={<Brain size={22} />}
              title={searchQuery ? "No matches" : "No memories yet"}
              description={
                searchQuery
                  ? `Nothing matches "${searchQuery}". Try a different search.`
                  : "Agents will build memory as they work — facts, decisions, and references the next run can recall."
              }
            />
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              {memories.map((mem) =>
                editingId === mem.id ? (
                  <Card key={mem.id} style={{ padding: 22 }}>
                    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                      <Field label="Name">
                        <Input
                          value={editForm.name}
                          onChange={(e) => setEditForm({ ...editForm, name: e.target.value })}
                        />
                      </Field>
                      <Field label="Type">
                        <Select
                          options={typeOptions}
                          value={editForm.type}
                          onChange={(v) => setEditForm({ ...editForm, type: v as MemoryType })}
                        />
                      </Field>
                      <Field label="Description" hint="Optional one-liner">
                        <Input
                          value={editForm.description}
                          onChange={(e) => setEditForm({ ...editForm, description: e.target.value })}
                        />
                      </Field>
                      <Field label="Body">
                        <Textarea
                          value={editForm.body}
                          rows={8}
                          onChange={(e) => setEditForm({ ...editForm, body: e.target.value })}
                        />
                      </Field>
                      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 4 }}>
                        <Button variant="ghost" size="sm" onClick={cancelEdit}>
                          Cancel
                        </Button>
                        <Button size="sm" disabled={saving} onClick={() => saveEdit(mem.id)}>
                          {saving ? "Saving…" : "Save"}
                        </Button>
                      </div>
                    </div>
                  </Card>
                ) : (
                  <MemoryRow
                    key={mem.id}
                    mem={mem}
                    onEdit={() => startEdit(mem)}
                    onDelete={() => removeOne(mem.id)}
                  />
                ),
              )}
            </div>
          )}
        </div>

        <Modal
          open={bulkDeleteOpen}
          onClose={() => setBulkDeleteOpen(false)}
          title="Delete memories"
          description={`Delete ${activeType === "all" ? "all memories" : `all "${activeType}" memories`}? This cannot be undone.`}
          footer={
            <>
              <Button variant="ghost" size="sm" onClick={() => setBulkDeleteOpen(false)}>
                Cancel
              </Button>
              <Button variant="danger" size="sm" onClick={removeBulk}>
                Delete
              </Button>
            </>
          }
        />
      </PageBody>
    </>
  );
}

function MemoryRow({
  mem,
  onEdit,
  onDelete,
}: {
  mem: MemorySummary;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <Card
      className="memory-row"
      style={{ padding: 18, position: "relative" }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0 }}>
          <Pill tone={typeToTone[mem.type]}>{mem.type}</Pill>
          <span
            style={{
              fontSize: 14,
              fontWeight: 500,
              color: "var(--vz-ink)",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {mem.name}
          </span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
          <span
            style={{
              fontFamily: "var(--vz-font-mono)",
              fontSize: 11,
              color: "var(--vz-muted-2)",
              letterSpacing: "0.02em",
            }}
            title={mem.updated_at}
          >
            {formatRelative(mem.updated_at)}
          </span>
          <button
            type="button"
            onClick={onEdit}
            aria-label="Edit memory"
            className="vz-action-btn"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            onClick={onDelete}
            aria-label="Delete memory"
            className="vz-action-btn vz-action-btn--danger"
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      {mem.description && (
        <p
          style={{
            fontFamily: "var(--vz-font-serif)",
            fontStyle: "italic",
            fontSize: 13.5,
            color: "var(--vz-muted)",
            margin: "8px 0 0",
          }}
        >
          {mem.description}
        </p>
      )}

      <p
        style={{
          fontSize: 14,
          color: "var(--vz-ink-3)",
          margin: "10px 0 0",
          lineHeight: 1.55,
          whiteSpace: "pre-line",
        }}
      >
        {truncate(mem.body, 220)}
      </p>

      <div
        style={{
          marginTop: 12,
          paddingTop: 10,
          borderTop: "1px dashed var(--vz-border)",
          fontFamily: "var(--vz-font-mono)",
          fontSize: 11,
          color: "var(--vz-muted-2)",
          letterSpacing: "0.04em",
        }}
      >
        {mem.profile_id ? `scope: profile ${mem.profile_id}` : "scope: user"}
      </div>
    </Card>
  );
}
