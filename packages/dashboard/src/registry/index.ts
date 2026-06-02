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

export { registerDefaults } from "./defaults.js";
