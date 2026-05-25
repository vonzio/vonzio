/**
 * Single source of truth for "which model would the next agent turn use?"
 *
 * Precedence (highest wins):
 *   1. task.model — explicit per-task override (set by API caller)
 *   2. workspace.model_override — per-workspace override (set by dashboard ModelPicker / /model bots)
 *   3. profile.model — the profile's default model
 *
 * The orchestrator's dispatch loop uses the same precedence to decide the
 * model it submits to the SDK; chat-surface pickers use a 2-arg subset
 * (no task) to render the "current" marker in the picker UI.
 *
 * Keeping this in one file means a future fourth tier (e.g. per-tenant
 * defaults) is a single edit, not three.
 */

import type { Workspace } from "@vonzio/shared";

/** Picker-time resolution: no task in flight, just workspace+profile. */
export function resolveWorkspaceModel(
  workspace: Pick<Workspace, "model_override"> | null | undefined,
  profile: { model?: string | null } | null | undefined,
): string | null {
  return workspace?.model_override ?? profile?.model ?? null;
}

/** Dispatch-time resolution: task-level override wins over workspace + profile. */
export function resolveTaskModel(
  task: { model?: string } | null | undefined,
  workspace: Pick<Workspace, "model_override"> | null | undefined,
  profile: { model?: string | null } | null | undefined,
): string | null {
  return task?.model ?? resolveWorkspaceModel(workspace, profile);
}
