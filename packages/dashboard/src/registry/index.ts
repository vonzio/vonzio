export type {
  Entitlement,
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
  getNavItems,
  getOnboardingSteps,
  getRoutes,
  getSettingsSections,
  getTopbarSlots,
  getUserMenuItems,
  getWorkspaceHeaderSlots,
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
