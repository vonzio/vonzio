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

export interface OnboardingStepProps {
  onNext: () => void;
  onSkip?: () => void;
}

export interface OnboardingStepReg {
  id: string;
  component: ComponentType<OnboardingStepProps>;
  predicate?: () => boolean;
  order?: number;
}

export interface UserMenuItemReg {
  id: string;
  label: ReactNode;
  onClick?: () => void;
  danger?: boolean;
  entitlement?: Entitlement;
  order?: number;
}
