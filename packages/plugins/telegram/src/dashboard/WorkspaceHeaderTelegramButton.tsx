// "Continue in Telegram" control shown in the workspace header, when the
// workspace's owner has a linked Telegram bot. Clicking it opens a popover
// with a QR code + deep link: scanning the QR (or tapping the link) sends
// `/start resume_<session>` to the bot, which binds that Telegram chat to this
// workspace so the conversation continues there. Contributed via
// `registerWorkspaceHeaderSlot` so the dashboard's WorkspaceHeader renders it
// alongside the other action buttons without knowing about telegram.
//
// Moved here from packages/dashboard/src/components/WorkspaceHeader.tsx
// in Phase 3D.1e; QR popover added later.

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { WorkspaceHeaderSlotProps } from "@vonzio/dashboard-registry";
import { fetchTelegramBotForWorkspace, type TelegramBotForWorkspace } from "./api.js";

export function WorkspaceHeaderTelegramButton({ workspace }: WorkspaceHeaderSlotProps) {
  // Resolve the best Telegram bot to deep-link this workspace into.
  // Server picks a bot bound to the workspace's profile if possible,
  // falls back to any linked bot. 404 or no-linked-bots returns null
  // and the control stays hidden.
  const [bot, setBot] = useState<TelegramBotForWorkspace | null>(null);
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sessionId = workspace.session_id;
    if (!sessionId) {
      setBot(null);
      return;
    }
    let cancelled = false;
    fetchTelegramBotForWorkspace(sessionId)
      .then((res) => { if (!cancelled) setBot(res.bot); })
      .catch(() => { if (!cancelled) setBot(null); });
    return () => { cancelled = true; };
  }, [workspace.session_id]);

  // Close the popover on outside click or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!bot) return null;

  const title = `Continue in Telegram via @${bot.bot_username}${bot.matched_by_profile ? " (bound to this agent)" : ""}`;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="vz-action-btn"
        style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 12 }}
        title={title}
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Send className="w-3 h-3" />
        <span className="hidden sm:inline">Telegram</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Continue this workspace in Telegram"
          style={{
            position: "absolute",
            top: "calc(100% + 8px)",
            right: 0,
            zIndex: 50,
            width: 232,
            padding: 14,
            borderRadius: 10,
            background: "var(--vz-page)",
            border: "1px solid var(--vz-border)",
            boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            gap: 10,
          }}
        >
          <div style={{ fontSize: 12, color: "var(--vz-ink)", textAlign: "center", fontWeight: 500 }}>
            Continue this workspace in Telegram
          </div>
          <div style={{ fontSize: 11, color: "var(--vz-muted-2)", textAlign: "center", marginTop: -4 }}>
            Scan with your phone, or open below.
          </div>
          <div style={{ background: "#fff", padding: 8, borderRadius: 8, lineHeight: 0 }}>
            <QRCodeSVG value={bot.deep_link} size={148} level="M" />
          </div>
          <a
            href={bot.deep_link}
            target="_blank"
            rel="noopener noreferrer"
            className="vz-action-btn"
            style={{ width: "100%", justifyContent: "center", gap: 6, fontSize: 12, textDecoration: "none" }}
            title={title}
          >
            <Send className="w-3 h-3" />
            Open in Telegram
          </a>
          <div style={{ fontSize: 11, color: "var(--vz-muted-2)" }}>@{bot.bot_username}</div>
        </div>
      )}
    </div>
  );
}
