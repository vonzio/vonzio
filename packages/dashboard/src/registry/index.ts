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
} from "./types.js";

export {
  getNavItems,
  getOnboardingSteps,
  getRoutes,
  getSettingsSections,
  getTopbarSlots,
  getUserMenuItems,
  registerNavItem,
  registerOnboardingStep,
  registerRoute,
  registerSettingsSection,
  registerTopbarSlot,
  registerUserMenuItem,
  resetRegistry,
} from "./registry.js";

export {
  EntitlementsProvider,
  useEntitlements,
  useHas,
} from "./EntitlementContext.js";

export { registerDefaults } from "./defaults.js";
