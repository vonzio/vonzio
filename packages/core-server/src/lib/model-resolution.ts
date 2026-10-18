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

/** Dispatch-time resolution: task-level override wins over workspace + profile.
 *
 *  The workspace's model_override is paired with its api_key_id_override (the
 *  picker sets both). When the credential could NOT be loaded from that key
 *  (deleted/revoked → getResolved fell back to the profile's key), the
 *  override model belongs to a key that isn't the one running the turn, so it
 *  is ignored and the profile default is used instead — sending e.g. an Ollama
 *  model to a ChatGPT key would just fail upstream. */
export function resolveTaskModel(
  task: { model?: string } | null | undefined,
  workspace: (Pick<Workspace, "model_override"> & { api_key_id_override?: string | null }) | null | undefined,
  profile: { model?: string | null; resolved_api_key_id?: string } | null | undefined,
): string | null {
  if (task?.model) return task.model;
  const overrideKey = workspace?.api_key_id_override;
  const keyMismatch = !!overrideKey && !!profile?.resolved_api_key_id && profile.resolved_api_key_id !== overrideKey;
  if (keyMismatch) return profile?.model ?? null;
  return resolveWorkspaceModel(workspace, profile);
}
