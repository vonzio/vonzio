import type { ComponentType, ReactNode } from "react";
import type { LucideIcon } from "lucide-react";

export type Entitlement = string;

export type RouteLayout = "shell" | "bare";

export interface RouteReg {
  id: string;
  path: string;
  element: ReactNode;
  layout?: RouteLayout;
  entitlement?: Entitlement;
  order?: number;
}

export type NavSection = "primary" | "admin" | "footer";

export interface NavItemReg {
  id: string;
  section: NavSection;
  label: string;
  to: string;
  icon: LucideIcon;
  match?: (pathname: string) => boolean;
  entitlement?: Entitlement;
  order?: number;
}

export interface SettingsSectionReg {
  id: string;
  label: string;
  lede?: string;
  component: ComponentType;
  entitlement?: Entitlement;
  order?: number;
}

export type TopbarSlotPlacement = "left" | "right" | "actions";

export interface TopbarSlotReg {
  id: string;
  placement: TopbarSlotPlacement;
  component: ComponentType;
  entitlement?: Entitlement;
  order?: number;
}

/** Slot rendered inside the workspace chat header, between the status
 *  pill and the action buttons. Receives the active workspace so the
 *  injected control can render in context (e.g. a VPN tunnel picker
 *  scoped to that session). Multiple slots are sorted by `order`. */
export interface WorkspaceHeaderSlotProps {
  workspace: {
    session_id: string;
    profile_id: string;
    /** Currently attached tunnel, if any. */
    attached_tunnel?: { id: string; name: string } | null;
  };
}

export interface WorkspaceHeaderSlotReg {
  id: string;
  component: ComponentType<WorkspaceHeaderSlotProps>;
  entitlement?: Entitlement;
  order?: number;
}

/** Slot rendered in the composer's meta line, alongside the ModelPicker.
 *  Designed for per-message / per-workspace choices: the picker can
 *  manage its own state but should treat `workspaceId === null` as
 *  "new chat, not yet created — stash the choice and apply after
 *  workspace creation". `profileId === null` means no profile is
 *  active yet either (extension should skip rendering or stay inert). */
export interface ComposerSlotProps {
  /** Active workspace session id, or null when the user is composing
   *  a new chat that hasn't been persisted yet. */
  workspaceId: string | null;
  /** Active profile id; null when no profile has been picked yet. */
  profileId: string | null;
  /** Currently-attached VPN tunnel for the running container, if any.
   *  Lets composer-side controls (e.g. the VPN picker) detect when a
   *  pinned override differs from what's actually wired up — Docker
   *  can't swap a container's network_mode mid-flight, so a change
   *  requires container recreation. */
  attachedTunnel?: { id: string; name: string } | null;
}

export interface ComposerSlotReg {
  id: string;
  component: ComponentType<ComposerSlotProps>;
  entitlement?: Entitlement;
  order?: number;
}

export interface OnboardingStepProps {
  onNext: () => void;
  onSkip?: () => void;
}

export interface OnboardingStepReg {
  id: string;
  component: ComponentType<OnboardingStepProps>;
  /** Returns true when this step should fire. Can be async — predicates
   *  often need a network round-trip (e.g. "does this user have any
   *  API keys yet?"). Steps without a predicate always fire. */
  predicate?: () => boolean | Promise<boolean>;
  order?: number;
}

/**
 * Slot for rendering an integration row inside Settings > Integrations.
 * Plugins use this to contribute their own row alongside the hardcoded
 * Email/Webhook/Git/Gmail/Teller surfaces; the section the row belongs
 * to drives visual grouping (Notifications & Chat vs Data Sources vs
 * the misc section). The row component owns its own data fetching --
 * the shared props (agentProfiles, integrations, ...) cover the common
 * dashboard-level state most rows need but extensions are free to
 * useApi for anything plugin-specific.
 *
 * Sections:
 *   - "notifications" — Slack, Email, Webhook (chat / outbound)
 *   - "data-sources" — Gmail, Bank, future data sources
 *   - "other" — uncategorized; renders at the end
 */
export type IntegrationRowSection = "notifications" | "data-sources" | "other";

export interface IntegrationRowSlotProps {
  /** Generic integration list. Cached at the page level; refetch via
   *  the parent. Plugins find their integration row by `i.type === <kind>`. */
  integrations: ReadonlyArray<{
    id: string;
    type: string;
    config: Record<string, unknown>;
    scope: "all" | "agents";
    profile_ids: string[];
    is_default?: boolean;
  }>;
  /** Agent profile list for the binding picker (when the row supports
   *  binding the integration to a specific agent). */
  agentProfiles: ReadonlyArray<{ id: string; slug: string; name: string }>;
  /** Re-fetch the parent's `integrations` array. Call after creating
   *  or deleting an integration so the row's "Connected/Not connected"
   *  badge updates. */
  refetch: () => void;
  /** Open the dashboard's scope-editor modal pre-filled with this
   *  integration. Plugins call this from a "Scope: <summary>" button.
   *  Pass the integration id only -- the dashboard looks up the full
   *  row internally. Avoids fn-param variance issues between the
   *  dashboard's wide Integration and the slot's narrow view. */
  openScopeEditor: (integrationId: string) => void;
  /** Set this integration as the user's default notification channel. */
  handleSetDefault: (integrationId: string) => Promise<void>;
  /** Trigger the "Test" send and surface the result via testResult. */
  handleTest: (integrationId: string) => Promise<void>;
  /** Latest test attempt; renders inline under the row when this row
   *  matches the testResult.id. */
  testResult: { id: string; status: "success" | "error"; message: string } | null;
  /** Currently-testing integration id (button disabled state). */
  testingId: string | null;
  /** Render a human summary of the integration's scope ("all agents"
   *  or "@<slug>" or "<N> agents"). Kept centralized so the wording
   *  is consistent across plugin and hardcoded rows. */
  scopeSummary: (integration: { scope?: "all" | "agents"; profile_ids?: string[] } | null | undefined) => string;
}

export interface IntegrationRowReg {
  id: string;
  /** Plugin-supplied row component. Owns the row visual + all its
   *  per-row state (modals, in-progress flags, popup hints, etc.). */
  component: ComponentType<IntegrationRowSlotProps>;
  /** Which visual section the row appears in. */
  section: IntegrationRowSection;
  entitlement?: Entitlement;
  /** Sort order within the section (lower = first). Hardcoded rows
   *  occupy 10-100 implicitly; plugins should pick numbers outside
   *  that range to land in the right relative position. */
  order?: number;
}

export interface UserMenuItemReg {
  id: string;
  label: ReactNode;
  /** Optional Lucide icon shown to the left of the label. */
  icon?: LucideIcon;
  /** Navigate to this path on click (uses react-router-dom). Mutually
   *  exclusive with `onClick` — `to` wins if both are set. */
  to?: string;
  /** Programmatic action on click. Use this when navigation alone
   *  isn't enough (e.g. opening a modal). */
  onClick?: () => void;
  danger?: boolean;
  entitlement?: Entitlement;
  /** Lower = higher in the menu. Hardcoded items get implicit orders
   *  (Settings=10, Operations=20, Agents=30) so extensions can slot
   *  between them by picking the appropriate number. */
  order?: number;
}
