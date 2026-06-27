export const WORKSPACE_STATUSES = ["active", "idle", "paused", "resumable", "expired"] as const;
export type WorkspaceStatus = (typeof WORKSPACE_STATUSES)[number];

/** Per-port "public with code" access. The code is stored encrypted (vault
 *  key), never plaintext; `code_version` bumps on rotate to invalidate any
 *  previously-issued access cookies. */
export interface PreviewCodeAccess {
  code_enc: string;
  code_version: number;
}

/** Resolved access mode for a single preview port. */
export type PreviewPortMode = "private" | "public" | "code";

export interface Workspace {
  session_id: string;
  container_id: string | null;
  user_id: string;
  /** SaaS tenant scope. Null/undefined on OSS deployments (and on legacy
   *  rows created before the v9 backfill). When set, every read/write
   *  path scopes by this id in addition to user_id (defense in depth). */
  org_id?: string | null;
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
  /** Container ports (as strings) exposed publicly through the preview proxy
   *  without auth — granular, per-service complement to `public_preview`. */
  public_ports: string[];
  /** Ports gated behind a shared access code (the "public with code" mode).
   *  Mutually exclusive with public_ports per port. Keyed by port string. */
  preview_codes: Record<string, PreviewCodeAccess>;
  model_override: string | null;
  /** Per-conversation API-key override. When set, this turn runs on this key's
   *  credential/provider/base_url instead of the profile's attached key — lets
   *  a workspace switch provider (e.g. Anthropic ↔ OpenAI) without changing the
   *  agent. Paired with `model_override`. Null = use the profile's key. */
  api_key_id_override: string | null;
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
