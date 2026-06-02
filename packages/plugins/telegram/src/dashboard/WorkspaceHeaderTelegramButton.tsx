// "Open in Telegram" deep-link button shown in the workspace header,
// when the workspace's owner has a linked Telegram bot. Contributed via
// `registerWorkspaceHeaderSlot` so the dashboard's WorkspaceHeader
// renders it alongside the other action buttons without knowing about
// telegram.
//
// Moved here from packages/dashboard/src/components/WorkspaceHeader.tsx
// in Phase 3D.1e.

import { useEffect, useState } from "react";
import { Send } from "lucide-react";
import type { WorkspaceHeaderSlotProps } from "@vonzio/dashboard/registry";
import { fetchTelegramBotForWorkspace, type TelegramBotForWorkspace } from "./api.js";

export function WorkspaceHeaderTelegramButton({ workspace }: WorkspaceHeaderSlotProps) {
  // Resolve the best Telegram bot to deep-link this workspace into.
  // Server picks a bot bound to the workspace's profile if possible,
  // falls back to any linked bot. 404 or no-linked-bots returns null
  // and the button stays hidden.
  const [bot, setBot] = useState<TelegramBotForWorkspace | null>(null);

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

  if (!bot) return null;

  return (
    <a
      href={bot.deep_link}
      target="_blank"
      rel="noopener noreferrer"
      className="vz-action-btn"
      style={{ width: "auto", padding: "0 8px", gap: 5, fontSize: 12, textDecoration: "none" }}
      title={`Continue in Telegram via @${bot.bot_username}${bot.matched_by_profile ? " (bound to this agent)" : ""}`}
    >
      <Send className="w-3 h-3" />
      <span className="hidden sm:inline">Telegram</span>
    </a>
  );
}
