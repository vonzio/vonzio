import { useState, useRef, useEffect } from "react";
import { Settings, LogOut, User, Activity, Bot } from "lucide-react";
import { useUser } from "../contexts/UserContext.js";

interface Props {
  onLogout: () => void;
  onSettings?: () => void;
  onOps?: () => void;
  onAgents?: () => void;
}

export function UserMenu({ onLogout, onSettings, onOps, onAgents }: Props) {
  const user = useUser();
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

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
          {onSettings && (
            <button
              onClick={() => { setOpen(false); onSettings(); }}
              className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
            >
              <Settings className="w-4 h-4" /> Settings
            </button>
          )}
          {onOps && (
            <button
              onClick={() => { setOpen(false); onOps(); }}
              className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
            >
              <Activity className="w-4 h-4" /> Operations
            </button>
          )}
          {onAgents && (
            <button
              onClick={() => { setOpen(false); onAgents(); }}
              className="flex items-center gap-2 px-3 py-2 w-full text-sm text-foreground hover:bg-secondary"
            >
              <Bot className="w-4 h-4" /> My Agents
            </button>
          )}
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
