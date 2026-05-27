import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import {
  Settings as SettingsIcon,
  Menu,
  LogOut,
  ChevronDown,
  Sun,
  Moon,
} from "lucide-react";
import { useUser } from "@/contexts/UserContext.js";
import { authClient } from "@/lib/auth-client.js";
import { useIsMobile } from "@/hooks/use-mobile.js";
import { useTheme } from "@/hooks/useTheme.js";
import { getNavItems, getUserMenuItems, useEntitlements, type NavItemReg } from "@/registry/index.js";
import { OnboardingHost } from "./OnboardingHost.js";
import {
  AppShell as ShellLayout,
  Rail,
  RailBrand,
  RailGroup,
  RailItem,
  RailSpacer,
  RailPin,
  TopBar,
  StatusBar,
  DropdownMenu,
  Avatar,
  type Crumb,
  type StatusChip,
  type MenuItem,
} from "@/brand/components.js";

type RailState = "collapsed" | "expanded" | "mobile-open";

const RAIL_PIN_KEY = "vonzio.rail.pinned";

function isEntitled(item: NavItemReg, entitlements: string[]): boolean {
  return !item.entitlement || entitlements.includes(item.entitlement);
}

function deriveCrumbs(pathname: string): Crumb[] {
  const all = getNavItems();
  const hit = all.find((it) => (it.match ?? ((p) => p.startsWith(it.to)))(pathname));
  return [{ label: hit?.label ?? "vonzio" }];
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const user = useUser();
  const location = useLocation();
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const entitlements = useEntitlements();
  const { surface, toggle: toggleSurface } = useTheme();

  const primaryItems = getNavItems("primary").filter((it) => isEntitled(it, entitlements));
  const adminItems = getNavItems("admin").filter((it) => isEntitled(it, entitlements));
  const footerItems = getNavItems("footer").filter((it) => isEntitled(it, entitlements));

  const [pinned, setPinned] = useState<boolean>(() => {
    try { return localStorage.getItem(RAIL_PIN_KEY) === "1"; } catch { return false; }
  });
  const [mobileOpen, setMobileOpen] = useState(false);

  useEffect(() => {
    try { localStorage.setItem(RAIL_PIN_KEY, pinned ? "1" : "0"); } catch { /* ignore */ }
  }, [pinned]);

  useEffect(() => { setMobileOpen(false); }, [location.pathname]);

  // While the mobile rail is open, any pointer-down outside the rail or the
  // hamburger toggle should close it. The CSS backdrop alone wasn't reliable
  // because clicks landing inside .vz-app__main descendants (cards, page
  // header content) hit those elements first instead of the backdrop.
  useEffect(() => {
    if (!mobileOpen) return;
    const handler = (e: MouseEvent | TouchEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest(".vz-app__rail")) return;
      if (target.closest("[data-shell-toggle]")) return;
      setMobileOpen(false);
    };
    // setTimeout so the click that opened the rail doesn't immediately close it.
    const t = setTimeout(() => {
      document.addEventListener("mousedown", handler);
      document.addEventListener("touchstart", handler);
    }, 0);
    return () => {
      clearTimeout(t);
      document.removeEventListener("mousedown", handler);
      document.removeEventListener("touchstart", handler);
    };
  }, [mobileOpen]);

  const railState: RailState = isMobile
    ? (mobileOpen ? "mobile-open" : "collapsed")
    : (pinned ? "expanded" : "collapsed");

  const version = (window as { __VONZIO_VERSION?: string }).__VONZIO_VERSION ?? "dev";
  const versionLabel = version === "dev" ? "dev" : `v${version}`;
  const displayName = user.name || user.email?.split("@")[0] || "user";

  const renderNavItem = (it: NavItemReg) => (
    <RailItem
      key={it.id}
      icon={<it.icon size={16} />}
      active={(it.match ?? ((p) => p.startsWith(it.to)))(location.pathname)}
      onClick={() => navigate(it.to)}
    >
      {it.label}
    </RailItem>
  );

  const railContent = (
    <Rail>
      <RailBrand>vonzio</RailBrand>
      {primaryItems.length > 0 && (
        <RailGroup label="Work">{primaryItems.map(renderNavItem)}</RailGroup>
      )}
      {adminItems.length > 0 && (
        <RailGroup label="Admin">{adminItems.map(renderNavItem)}</RailGroup>
      )}
      <RailSpacer />
      {footerItems.length > 0 && (
        <RailGroup>{footerItems.map(renderNavItem)}</RailGroup>
      )}
      {!isMobile && <RailPin pinned={pinned} onToggle={() => setPinned((p) => !p)} />}
    </Rail>
  );

  // Build the topbar user dropdown. Settings is hardcoded at order 10;
  // registry-driven items (via registerUserMenuItem) slot in by order;
  // Sign out is pinned at the bottom, danger-styled.
  const topMenuRows: { order: number; item: MenuItem }[] = [
    {
      order: 10,
      item: {
        label: <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><SettingsIcon size={14} /> Settings</span>,
        onClick: () => navigate("/settings"),
      },
    },
  ];
  for (const reg of getUserMenuItems()) {
    if (reg.entitlement && !entitlements.includes(reg.entitlement)) continue;
    const Icon = reg.icon;
    const label = (
      <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
        {Icon && <Icon size={14} />} {reg.label}
      </span>
    );
    // `to` items navigate via react-router; `onClick` items fire as-is.
    const onClick = reg.to
      ? () => navigate(reg.to as string)
      : reg.onClick;
    topMenuRows.push({
      order: reg.order ?? 100,
      item: { label, onClick, danger: reg.danger },
    });
  }
  topMenuRows.sort((a, b) => a.order - b.order);

  const userMenu = (
    <DropdownMenu
      align="right"
      trigger={
        <button type="button" className="vz-topbar__user" aria-label="Account menu">
          <Avatar size="sm" name={displayName} />
          <span className="vz-topbar__user-name">{displayName}</span>
          <ChevronDown size={14} style={{ opacity: 0.5 }} />
        </button>
      }
      items={[
        { type: "label", label: user.email ?? "" },
        { type: "sep" },
        ...topMenuRows.map((r) => r.item),
        { type: "sep" as const },
        {
          label: <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}><LogOut size={14} /> Sign out</span>,
          onClick: () => authClient.signOut().then(() => window.location.reload()),
          danger: true,
        },
      ]}
    />
  );

  const themeToggle = (
    <button
      type="button"
      onClick={toggleSurface}
      className="vz-topbar__icon-btn"
      title={`Switch to ${surface === "carbon" ? "light" : "dark"} mode`}
      aria-label={`Switch to ${surface === "carbon" ? "light" : "dark"} mode`}
    >
      {surface === "carbon" ? <Sun size={16} /> : <Moon size={16} />}
    </button>
  );

  const actions = (
    <>
      {themeToggle}
      {userMenu}
    </>
  );

  const topbar = (
    <>
      {isMobile && (
        <button
          type="button"
          onClick={() => setMobileOpen((o) => !o)}
          className="vz-topbar__icon-btn"
          aria-label="Toggle navigation"
          data-shell-toggle="true"
        >
          <Menu size={18} />
        </button>
      )}
      <TopBar
        crumbs={deriveCrumbs(location.pathname)}
        onCmdK={() => { /* TODO wire CommandPalette */ }}
        actions={actions}
      />
    </>
  );

  const chips: StatusChip[] = [
    { label: "connected", tone: "ok" },
  ];

  const statusbar = (
    <StatusBar
      chips={chips}
      meta={
        <>
          <span>{user.email}</span>
          <span>{versionLabel}</span>
        </>
      }
    />
  );

  return (
    <ShellLayout
      rail={railContent}
      topbar={topbar}
      statusbar={statusbar}
      railState={railState}
      onBackdropClick={() => setMobileOpen(false)}
    >
      {children}
      {/* Onboarding modal — fires when a registered step's predicate
       *  matches (e.g. brand-new user with no API key). Renders at most
       *  one step per session; dismissed steps cached in sessionStorage. */}
      <OnboardingHost />
    </ShellLayout>
  );
}
