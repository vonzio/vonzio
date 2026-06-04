// @vonzio/dashboard-registry — the frontend slot registry shared by the vonzio
// dashboard and the plugins that extend it. A plugin's frontend entry imports
// the register* functions (see ./api for the lightweight, types-only subset);
// the dashboard imports the get* readers + the entitlements context to render
// what plugins registered.
//
// First-party dashboard defaults (routes/pages/nav for the built-in shell) are
// NOT here — they live in the dashboard app (registerDefaults), because they
// pull in concrete pages. This package stays generic + publishable.

export type {
  ComposerSlotProps,
  ComposerSlotReg,
  Entitlement,
  IntegrationRowReg,
  IntegrationRowSection,
  IntegrationRowSlotProps,
  NavItemReg,
  NavSection,
  OnboardingStepProps,
  OnboardingStepReg,
  RouteLayout,
  RouteReg,
  SettingsSectionReg,
  TopbarSlotPlacement,
  TopbarSlotReg,
  UserMenuItemReg,
  WorkspaceHeaderSlotProps,
  WorkspaceHeaderSlotReg,
} from "./types.js";

export {
  getComposerSlots,
  getIntegrationRows,
  getNavItems,
  getOnboardingSteps,
  getRoutes,
  getSettingsSections,
  getTopbarSlots,
  getUserMenuItems,
  getWorkspaceHeaderSlots,
  registerComposerSlot,
  registerIntegrationRow,
  registerNavItem,
  registerOnboardingStep,
  registerRoute,
  registerSettingsSection,
  registerTopbarSlot,
  registerUserMenuItem,
  registerWorkspaceHeaderSlot,
  resetRegistry,
} from "./registry.js";

export {
  EntitlementsProvider,
  useEntitlements,
  useHas,
} from "./EntitlementContext.js";
