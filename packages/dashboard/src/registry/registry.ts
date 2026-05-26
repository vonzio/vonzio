import type {
  NavItemReg,
  OnboardingStepReg,
  RouteReg,
  SettingsSectionReg,
  TopbarSlotReg,
  UserMenuItemReg,
} from "./types.js";

interface RegistryState {
  routes: Map<string, RouteReg>;
  navItems: Map<string, NavItemReg>;
  settingsSections: Map<string, SettingsSectionReg>;
  topbarSlots: Map<string, TopbarSlotReg>;
  onboardingSteps: Map<string, OnboardingStepReg>;
  userMenuItems: Map<string, UserMenuItemReg>;
}

function createState(): RegistryState {
  return {
    routes: new Map(),
    navItems: new Map(),
    settingsSections: new Map(),
    topbarSlots: new Map(),
    onboardingSteps: new Map(),
    userMenuItems: new Map(),
  };
}

const state: RegistryState = createState();

const DEFAULT_ORDER = 100;

function sortByOrder<T extends { order?: number }>(items: T[]): T[] {
  return [...items].sort(
    (a, b) => (a.order ?? DEFAULT_ORDER) - (b.order ?? DEFAULT_ORDER),
  );
}

export function registerRoute(reg: RouteReg): void {
  state.routes.set(reg.id, reg);
}

export function registerNavItem(reg: NavItemReg): void {
  state.navItems.set(reg.id, reg);
}

export function registerSettingsSection(reg: SettingsSectionReg): void {
  state.settingsSections.set(reg.id, reg);
}

export function registerTopbarSlot(reg: TopbarSlotReg): void {
  state.topbarSlots.set(reg.id, reg);
}

export function registerOnboardingStep(reg: OnboardingStepReg): void {
  state.onboardingSteps.set(reg.id, reg);
}

export function registerUserMenuItem(reg: UserMenuItemReg): void {
  state.userMenuItems.set(reg.id, reg);
}

export function getRoutes(): RouteReg[] {
  return sortByOrder(Array.from(state.routes.values()));
}

export function getNavItems(section?: NavItemReg["section"]): NavItemReg[] {
  const all = sortByOrder(Array.from(state.navItems.values()));
  return section ? all.filter((it) => it.section === section) : all;
}

export function getSettingsSections(): SettingsSectionReg[] {
  return sortByOrder(Array.from(state.settingsSections.values()));
}

export function getTopbarSlots(
  placement?: TopbarSlotReg["placement"],
): TopbarSlotReg[] {
  const all = sortByOrder(Array.from(state.topbarSlots.values()));
  return placement ? all.filter((it) => it.placement === placement) : all;
}

export function getOnboardingSteps(): OnboardingStepReg[] {
  return sortByOrder(Array.from(state.onboardingSteps.values()));
}

export function getUserMenuItems(): UserMenuItemReg[] {
  return sortByOrder(Array.from(state.userMenuItems.values()));
}

export function resetRegistry(): void {
  state.routes.clear();
  state.navItems.clear();
  state.settingsSections.clear();
  state.topbarSlots.clear();
  state.onboardingSteps.clear();
  state.userMenuItems.clear();
}
