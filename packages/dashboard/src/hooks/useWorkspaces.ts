import { useState, useEffect, useCallback } from "react";
import { fetchWorkspaces, updateWorkspace, deleteWorkspace, type WorkspaceSummary } from "../api/client.js";

export interface GroupedWorkspaces {
  starred: WorkspaceSummary[];
  active: WorkspaceSummary[];
  paused: WorkspaceSummary[];
  archived: WorkspaceSummary[];
}

export function useWorkspaces() {
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const data = await fetchWorkspaces();
      setWorkspaces(data.workspaces);
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const interval = setInterval(load, 30000);
    return () => clearInterval(interval);
  }, [load]);

  // Status-to-group mapping. The actual workspace lifecycle (see
  // server `WORKSPACE_STATUSES`) is:
  //   active → idle → paused → resumable → expired
  // The previous filters excluded `expired` from every group, hiding
  // 91 workspaces from the admin user on prod. Now `expired` flows
  // through `archived` so the sidebar's history bucketing sees it.
  // `completed` / `failed` / `cancelled` aren't reached by current
  // server code, but kept here defensively in case future work
  // introduces them as terminal states.
  const FINISHED_STATUSES = new Set(["expired", "completed", "failed", "cancelled"]);
  const grouped: GroupedWorkspaces = {
    starred: workspaces.filter((w) => w.starred || w.pinned).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)),
    active: workspaces.filter((w) => !w.starred && !w.pinned && !w.archived && (w.status === "active" || w.status === "idle")).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)),
    paused: workspaces.filter((w) => !w.starred && !w.pinned && !w.archived && (w.status === "paused" || w.status === "resumable")).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)),
    archived: workspaces.filter((w) => w.archived || FINISHED_STATUSES.has(w.status)).sort((a, b) => b.last_active_at.localeCompare(a.last_active_at)),
  };

  const update = useCallback(async (id: string, fields: Parameters<typeof updateWorkspace>[1]) => {
    const updated = await updateWorkspace(id, fields);
    setWorkspaces((prev) => prev.map((w) => w.session_id === id ? { ...w, ...updated } : w));
    return updated;
  }, []);

  const remove = useCallback(async (id: string) => {
    await deleteWorkspace(id);
    setWorkspaces((prev) => prev.filter((w) => w.session_id !== id));
  }, []);

  return { workspaces, grouped, loading, refetch: load, update, remove };
}
