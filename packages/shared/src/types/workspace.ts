export const WORKSPACE_STATUSES = ["active", "idle", "paused", "resumable", "expired"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

export interface Workspace {
  session_id: string;
  container_id: string | null;
  user_id: string;
  profile_id: string;
  name: string | null;
  pinned: boolean;
  starred: boolean;
  tags: string[];
  archived: boolean;
  last_opened_at: string | null;
  persistent: boolean;
  volume_id: string | null;
  volume_expires_at: string | null;
  public_preview: boolean;
  model_override: string | null;
  /** Model that produced the most recent completed turn. Used to detect a
   *  cross-model switch and trigger transcript replay (the SDK's resume
   *  doesn't carry context across model identity changes). */
  last_run_model: string | null;
  status: WorkspaceStatus;
  last_active_at: string;
  created_at: string;
  expires_at: string;
  /** Currently attached VPN tunnel, if any. Null when the workspace's
   *  agent isn't routed through a tunnel (OSS, or SaaS user without
   *  an enabled tunnel matching this profile). UI shows a pill in the
   *  chat header so the operator can tell at a glance which session
   *  is on which network. */
  attached_tunnel?: { id: string; name: string } | null;
  /** Transient in-memory flag, NOT persisted. Set when a session is
   *  resurrected from an expired DB row — the SDK's session storage on
   *  the old container is gone (or never existed in this new container),
   *  so the orchestrator must rebuild context from EventLog and prefix
   *  it to the next prompt. Cleared by the orchestrator after the first
   *  task fires. Same code path as `crossModelReplay`. */
  needs_context_replay?: boolean;
}
