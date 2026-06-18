/**
 * Home / launcher (feature 0027) — the landing page.
 *
 * Replaces "drop straight into a new workspace" with an agent-centric launcher:
 * a quick prompt, your agents as cards, templates, and recent runs. Starting
 * anything hands off into the Workspace (the composer lives there); a short
 * draft / chosen-agent are passed via localStorage and picked up on /w mount.
 */
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bot, Sparkles, Send, Clock, Wrench, ArrowRight } from "lucide-react";
import { useApi } from "../hooks/useApi.js";
import { fetchProfiles, fetchWorkspaces, type ProfileSummary, type WorkspaceListResponse } from "../api/client.js";
import { Button } from "../brand/components.js";
import { formatRelative } from "../lib/utils.js";

// Handoff keys read by Workspace on a fresh /w mount.
export const HOME_DRAFT_KEY = "vonzio_home_draft";
export const HOME_AGENT_KEY = "vonzio_home_agent";

export function Home() {
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const { data: workspaces } = useApi<WorkspaceListResponse>(() => fetchWorkspaces());

  const agents = profiles ?? [];
  const allWorkspaces = workspaces?.workspaces ?? [];
  const recent = allWorkspaces.slice(0, 6);

  // Derive each agent's last-used from actual workspaces — profile.last_used_at
  // isn't reliably written by the runtime, so it reads "Never used" even when it
  // has been. Most-recent workspace per profile_id wins.
  const lastUsedByAgent = new Map<string, string>();
  for (const w of allWorkspaces) {
    if (!w.profile_id || !w.last_active_at) continue;
    const prev = lastUsedByAgent.get(w.profile_id);
    if (!prev || w.last_active_at > prev) lastUsedByAgent.set(w.profile_id, w.last_active_at);
  }

  function startChat(opts?: { agentId?: string }) {
    try {
      if (prompt.trim()) localStorage.setItem(HOME_DRAFT_KEY, prompt.trim());
      if (opts?.agentId) localStorage.setItem(HOME_AGENT_KEY, opts.agentId);
    } catch { /* ignore storage errors */ }
    navigate("/w");
  }

  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "56px 24px 64px", display: "flex", flexDirection: "column", gap: 28 }}>
      <div style={{ textAlign: "center", display: "flex", flexDirection: "column", alignItems: "center", gap: 8 }}>
        <svg viewBox="0 0 512 512" style={{ width: 40, height: 40 }}>
          <circle cx="256" cy="256" r="256" fill="var(--vz-brand-tile)" />
          <polyline points="165,160 256,290 347,160" fill="none" stroke="var(--vz-brand-on-tile)" strokeWidth="50" strokeLinecap="round" strokeLinejoin="round" />
          <rect x="190" y="330" width="132" height="28" rx="14" fill="var(--vz-brand-on-tile)" />
        </svg>
        <h1 style={{ fontSize: 22, fontWeight: 600, color: "var(--vz-ink)", margin: 0 }}>How can I help?</h1>
        <p style={{ fontSize: 13, color: "var(--vz-muted)", margin: 0 }}>Start a chat, pick an agent, or open a template.</p>
      </div>

      {/* Quick prompt — fast path. Hands the text to the workspace composer. */}
      <form
        onSubmit={(e) => { e.preventDefault(); startChat(); }}
        style={{ display: "flex", gap: 8 }}
      >
        <input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="Message vonzio…"
          className="vz-input"
          style={{ flex: 1, padding: "12px 14px", fontSize: 14 }}
        />
        <Button type="submit" icon={<Send size={15} />}>Start</Button>
      </form>

      {agents.length > 0 && (
        <div>
          <SectionLabel>Your agents</SectionLabel>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 10 }}>
            {agents.map((a) => (
              <AgentCard
                key={a.id}
                agent={a}
                lastUsedAt={lastUsedByAgent.get(a.id) ?? a.last_used_at}
                onStart={() => startChat({ agentId: a.id })}
              />
            ))}
          </div>
        </div>
      )}

      <div>
        <SectionLabel>Templates</SectionLabel>
        <Button variant="ghost" size="sm" icon={<Sparkles size={14} />} onClick={() => navigate("/agents/gallery")}>
          Browse agent templates
        </Button>
      </div>

      {recent.length > 0 && (
        <div>
          <SectionLabel>Recent</SectionLabel>
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {recent.map((w) => {
              const id = w.session_id;
              if (!id) return null;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => navigate(`/w/${id}`)}
                  style={{
                    display: "flex", alignItems: "center", gap: 9, padding: "8px 10px", textAlign: "left",
                    borderRadius: "var(--vz-radius-sm)", cursor: "pointer", fontSize: 13, fontFamily: "inherit",
                    background: "none", border: 0, color: "var(--vz-ink)",
                  }}
                >
                  <Clock size={13} style={{ color: "var(--vz-muted-2)", flexShrink: 0 }} />
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }}>{w.name || "Untitled"}</span>
                  {w.last_active_at && (
                    <span style={{ flexShrink: 0, fontSize: 11, color: "var(--vz-muted-2)" }}>{formatRelative(w.last_active_at)}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function AgentCard({ agent, lastUsedAt, onStart }: { agent: ProfileSummary; lastUsedAt?: string | null; onStart: () => void }) {
  const [hover, setHover] = useState(false);
  const model = agent.model || "Default model";
  const toolCount = agent.default_tools?.length ?? 0;
  return (
    <button
      type="button"
      onClick={onStart}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "flex", flexDirection: "column", gap: 8, padding: "13px 14px", textAlign: "left",
        borderRadius: "var(--vz-radius-md)", cursor: "pointer", fontFamily: "inherit",
        background: hover ? "var(--vz-sodium-08)" : "var(--vz-card)",
        border: `1px solid ${hover ? "var(--vz-sodium-25)" : "var(--vz-border)"}`,
        color: "var(--vz-ink)", transition: "background 120ms, border-color 120ms",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Bot size={16} style={{ color: "var(--vz-sodium)", flexShrink: 0 }} />
        <span style={{ fontSize: 14, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{agent.name}</span>
        {agent.team_owned && (
          <span style={{ marginLeft: "auto", fontSize: 9.5, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)", border: "1px solid var(--vz-border)", borderRadius: 4, padding: "1px 5px" }}>Team</span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, fontSize: 11.5, color: "var(--vz-muted)" }}>
        <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{model}</span>
        {toolCount > 0 && (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 3, flexShrink: 0 }}>
            <Wrench size={11} /> {toolCount}
          </span>
        )}
      </div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 11, color: "var(--vz-muted-2)" }}>
        <span>{lastUsedAt ? `Used ${formatRelative(lastUsedAt)}` : "Not used yet"}</span>
        <span style={{ display: "inline-flex", alignItems: "center", gap: 3, color: hover ? "var(--vz-sodium)" : "var(--vz-muted-2)", fontWeight: 500 }}>
          Start <ArrowRight size={12} />
        </span>
      </div>
    </button>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontFamily: "var(--vz-font-mono)", fontSize: 10.5, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--vz-muted-2)", marginBottom: 10 }}>
      {children}
    </div>
  );
}
