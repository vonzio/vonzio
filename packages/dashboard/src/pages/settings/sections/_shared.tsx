import { type ReactNode } from "react";
import { Field, Radio, Checkbox } from "../../../brand/components.js";
import type { SecretScope, ProfileSummary } from "../../../api/client.js";

// ───────────────────────────────────────────────────────────────────
// Small shared helpers used by multiple settings sections.
// ───────────────────────────────────────────────────────────────────

export function ErrorBanner({ message, onDismiss }: { message: string; onDismiss: () => void }) {
  return (
    <div
      style={{
        display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
        fontSize: 13, color: "var(--vz-fail)",
        background: "rgba(220, 38, 38, 0.08)",
        border: "1px solid rgba(220, 38, 38, 0.25)",
        padding: "10px 12px",
        borderRadius: "var(--vz-radius-md)",
        marginBottom: 16,
        fontFamily: "var(--vz-font-mono)",
      }}
    >
      <span>{message}</span>
      <button type="button" onClick={onDismiss} style={{ background: "none", border: 0, cursor: "pointer", color: "var(--vz-fail)", fontSize: 12 }}>
        ×
      </button>
    </div>
  );
}

export function SubLabel({ children }: { children: ReactNode }) {
  return (
    <div style={{
      fontFamily: "var(--vz-font-mono)",
      fontSize: 11,
      letterSpacing: "0.14em",
      textTransform: "uppercase",
      color: "var(--vz-muted-2)",
      marginBottom: 10,
    }}>
      {children}
    </div>
  );
}

export function ScopePicker({
  name = "secretScope",
  hint = "All agents: injected into every container. Specific: only the selected agents see it.",
  scope, setScope, profileIds, setProfileIds, agentProfiles,
}: {
  name?: string;
  hint?: string;
  scope: SecretScope;
  setScope: (s: SecretScope) => void;
  profileIds: string[];
  setProfileIds: (ids: string[]) => void;
  agentProfiles: ProfileSummary[];
}) {
  return (
    <Field label="Scope" hint={hint}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        <Radio
          name={name}
          checked={scope === "all"}
          onChange={(c) => { if (c) setScope("all"); }}
        >
          All agents
        </Radio>
        <Radio
          name={name}
          checked={scope === "agents"}
          onChange={(c) => { if (c) setScope("agents"); }}
        >
          Specific agents
        </Radio>
        {scope === "agents" && (
          <div
            style={{
              marginLeft: 24, marginTop: 4,
              display: "flex", flexDirection: "column", gap: 6,
              padding: 10,
              border: "1px solid var(--vz-border)",
              borderRadius: 6,
              background: "var(--vz-mute)",
              maxHeight: 200, overflowY: "auto",
            }}
          >
            {agentProfiles.length === 0 ? (
              <span style={{ fontSize: 12, color: "var(--vz-muted)" }}>No agents available.</span>
            ) : (
              agentProfiles.map((p) => (
                <Checkbox
                  key={p.id}
                  checked={profileIds.includes(p.id)}
                  onChange={(checked) => {
                    if (checked) setProfileIds([...profileIds, p.id]);
                    else setProfileIds(profileIds.filter((id) => id !== p.id));
                  }}
                >
                  <span style={{ fontSize: 13 }}>
                    {p.name}
                    {p.user_id == null && (
                      <span style={{ color: "var(--vz-muted-2)", fontSize: 11, marginLeft: 6 }}>shared</span>
                    )}
                  </span>
                </Checkbox>
              ))
            )}
          </div>
        )}
      </div>
    </Field>
  );
}
