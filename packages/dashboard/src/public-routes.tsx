import type { ReactElement } from "react";

/**
 * Public (pre-auth) route seam.
 *
 * Core OSS public pages (/invite, /reset-password) are wired directly in
 * App.tsx. Cloud-only public surfaces register here before App mounts — e.g.
 * the embeddable /chat page, which moved to cp-dashboard now that the widget
 * is a SaaS-only feature. OSS registers nothing, so it ships with no embed
 * surface; the seam keeps App.tsx free of cloud-specific routes (no drift).
 */
export interface PublicRoute {
  path: string;
  element: ReactElement;
}

const routes: PublicRoute[] = [];

/**
 * Register a public route. Call once at app startup (before App mounts), not
 * during render. Idempotent by path, so an HMR re-run of the registrant won't
 * accumulate duplicates.
 */
export function registerPublicRoute(route: PublicRoute): void {
  if (!routes.some((r) => r.path === route.path)) routes.push(route);
}

export function getPublicRoutes(): readonly PublicRoute[] {
  return routes;
}
