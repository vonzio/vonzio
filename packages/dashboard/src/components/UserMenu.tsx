import { useState, useRef, useEffect, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Settings, LogOut, Activity, Bot } from "lucide-react";
import { useUser } from "../contexts/UserContext.js";
import { getUserMenuItems } from "../registry/index.js";
import { useEntitlements } from "../registry/EntitlementContext.js";

interface Props {
  onLogout: () => void;
  onSettings?: () => void;
  onOps?: () => void;
  onAgents?: () => void;
}

interface MenuRow {
  key: string;
  order: number;
  render: (closeMenu: () => void) => ReactNode;
}

export function UserMenu({ onLogout, onSettings, onOps, onAgents }: Props) {
  const user = useUser();
  const entitlements = useEntitlements();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const close = () => setOpen(false);

  // Build a unified, order-sortable list of all menu rows EXCEPT logout
  // (which always lives at the bottom, visually separated). Hardcoded
  // entries get implicit orders so registry items can slot between them.
  const rows: MenuRow[] = [];

  if (onSettings) {
    rows.push({
      key: "_settings",
      order: 10,
      render: (closeMenu) => (
        <button
          key="_settings"
          onClick={() => { closeMenu(); onSettings(); }}
          className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
        >
          <Settings className="w-4 h-4" /> Settings
        </button>
      ),
    });
  }
  if (onOps) {
    rows.push({
      key: "_ops",
      order: 20,
      render: (closeMenu) => (
        <button
          key="_ops"
          onClick={() => { closeMenu(); onOps(); }}
          className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
        >
          <Activity className="w-4 h-4" /> Operations
        </button>
      ),
    });
  }
  if (onAgents) {
    rows.push({
      key: "_agents",
      order: 30,
      render: (closeMenu) => (
        <button
          key="_agents"
          onClick={() => { closeMenu(); onAgents(); }}
          className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
        >
          <Bot className="w-4 h-4" /> My Agents
        </button>
      ),
    });
  }

  // Registry-driven items. Entitlement-gated, sorted with hardcoded
  // rows by `order`. `to` items render as react-router Links so client-
  // side navigation works; `onClick` items render as plain buttons.
  for (const item of getUserMenuItems()) {
    if (item.entitlement && !entitlements.includes(item.entitlement)) continue;
    const Icon = item.icon;
    rows.push({
      key: item.id,
      order: item.order ?? 100,
      render: (closeMenu) => {
        const body = (
          <>
            {Icon && <Icon className="w-4 h-4" />}
            <span>{item.label}</span>
          </>
        );
        const className = `flex items-center gap-2 px-3 py-2 w-full text-sm hover:bg-secondary ${item.danger ? "text-destructive hover:bg-red-50" : "text-foreground"}`;
        if (item.to) {
          return (
            <Link
              key={item.id}
              to={item.to}
              onClick={closeMenu}
              className={className}
            >
              {body}
            </Link>
          );
        }
        return (
          <button
            key={item.id}
            onClick={() => { closeMenu(); item.onClick?.(); }}
            className={className}
          >
            {body}
          </button>
        );
      },
    });
  }

  rows.sort((a, b) => a.order - b.order);

  return (
    <div ref={menuRef} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary rounded-md transition-colors"
      >
        <div className="w-6 h-6 rounded-full bg-accent/10 text-accent flex items-center justify-center text-xs font-medium">
          {user.name?.charAt(0)?.toUpperCase() ?? "U"}
        </div>
        <span className="flex-1 truncate text-left">{user.name ?? user.email}</span>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1 w-full bg-background border border-border rounded-md shadow-lg z-50">
          <div className="px-3 py-2.5 border-b border-border">
            <div className="text-sm font-medium text-foreground">{user.name}</div>
            <div className="text-[11px] text-muted-foreground">{user.email}</div>
          </div>
          <div className="py-1">
            {rows.map((r) => r.render(close))}
            <button
              onClick={() => { setOpen(false); onLogout(); }}
              className="flex items-center gap-2 px-3 py-2 w-full text-sm text-destructive hover:bg-red-50"
            >
              <LogOut className="w-4 h-4" /> Logout
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
