import React, { useState, useEffect, type ReactNode } from "react";
import { Link2, Unlink } from "lucide-react";
import {
  Card, Button, Field, Input, Pill,
} from "../../../brand/components.js";
import { authClient } from "../../../lib/auth-client.js";
import { useUser } from "../../../contexts/UserContext.js";
import { ErrorBanner, SubLabel } from "./_shared.js";

// ───────────────────────────────────────────────────────────────────
// Account
// ───────────────────────────────────────────────────────────────────

interface AccountInfo { id: string; accountId: string; providerId: string; }

export function AccountSection() {
  const user = useUser();
  const [accounts, setAccounts] = useState<AccountInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [authProviders, setAuthProviders] = useState<{ google?: boolean; github?: boolean }>({});

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c) => {
      if (c.authProviders) setAuthProviders(c.authProviders);
    }).catch(() => {});
    authClient.listAccounts().then((res) => {
      if (res.data) setAccounts(res.data as unknown as AccountInfo[]);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const isLinked = (provider: string) => accounts.some((a) => a.providerId === provider);
  const handleLink = async (provider: "google" | "github") => {
    await authClient.linkSocial({ provider, callbackURL: "/settings#account" });
  };
  const handleUnlink = async (providerId: string) => {
    setError("");
    try {
      const account = accounts.find((a) => a.providerId === providerId);
      if (!account) return;
      await authClient.unlinkAccount({ providerId });
      setAccounts((prev) => prev.filter((a) => a.providerId !== providerId));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unlink");
    }
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "repeat(auto-fit, minmax(320px, 1fr))",
        gap: 16,
      }}
    >
      <Card>
        <SubLabel>Profile</SubLabel>
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <ProfileRow label="Name" value={user.name ?? "—"} />
          <ProfileRow label="Email" value={user.email ?? "—"} />
          <ProfileRow
            label="Role"
            value={<Pill tone={user.role === "admin" ? "info" : undefined}>{user.role}</Pill>}
          />
        </div>
      </Card>
      <ChangePasswordCard />

      {(authProviders.google || authProviders.github) && (
        <Card>
          <SubLabel>Connected accounts</SubLabel>
          <div style={{ fontSize: 12.5, color: "var(--vz-muted)", marginBottom: 12, marginTop: -4 }}>
            Link external accounts for faster sign-in.
          </div>
          {error && <ErrorBanner message={error} onDismiss={() => setError("")} />}
          {loading ? (
            <div style={{ fontSize: 12, color: "var(--vz-muted)", fontFamily: "var(--vz-font-mono)" }}>loading…</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column" }}>
              {authProviders.google && (
                <ProviderRow
                  name="Google"
                  icon={<GoogleIcon />}
                  linked={isLinked("google")}
                  onLink={() => handleLink("google")}
                  onUnlink={() => handleUnlink("google")}
                />
              )}
              {authProviders.github && (
                <ProviderRow
                  name="GitHub"
                  icon={<GithubIcon />}
                  linked={isLinked("github")}
                  onLink={() => handleLink("github")}
                  onUnlink={() => handleUnlink("github")}
                />
              )}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

function ProfileRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
      <span style={{ fontSize: 13, color: "var(--vz-muted)" }}>{label}</span>
      <span style={{ fontSize: 14, color: "var(--vz-ink-3)", fontWeight: 500 }}>{value}</span>
    </div>
  );
}

function ProviderRow({
  name, icon, linked, onLink, onUnlink,
}: { name: string; icon: ReactNode; linked: boolean; onLink: () => void; onUnlink: () => void }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
      padding: "10px 0", borderBottom: "1px solid var(--vz-border)",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span style={{ width: 20, height: 20, display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
          {icon}
        </span>
        <div>
          <div style={{ fontSize: 13.5, fontWeight: 500, color: "var(--vz-ink)" }}>{name}</div>
          <div style={{ fontSize: 11.5, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
            {linked ? "connected" : "not connected"}
          </div>
        </div>
      </div>
      {linked ? (
        <Button variant="danger-ghost" size="sm" icon={<Unlink size={13} />} onClick={onUnlink}>
          Disconnect
        </Button>
      ) : (
        <Button variant="ghost" size="sm" icon={<Link2 size={13} />} onClick={onLink}>
          Connect
        </Button>
      )}
    </div>
  );
}

function ChangePasswordCard() {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (newPassword.length < 8) { setError("New password must be at least 8 characters"); return; }
    if (newPassword !== confirmPassword) { setError("Passwords don't match"); return; }
    setError(""); setSuccess(""); setLoading(true);
    const { error: err } = await authClient.changePassword({ currentPassword, newPassword });
    setLoading(false);
    if (err) {
      setError(err.message ?? "Failed to change password");
    } else {
      setSuccess("Password updated.");
      setCurrentPassword(""); setNewPassword(""); setConfirmPassword("");
    }
  }

  return (
    <Card>
      <SubLabel>Password</SubLabel>
      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
        <Field label="Current password">
          <Input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} required />
        </Field>
        <Field label="New password" hint="Minimum 8 characters">
          <Input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} required />
        </Field>
        <Field label="Confirm new password">
          <Input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} required />
        </Field>
        {error && <p style={{ fontSize: 12.5, color: "var(--vz-fail)", margin: 0 }}>{error}</p>}
        {success && <p style={{ fontSize: 12.5, color: "var(--vz-ok)", margin: 0 }}>{success}</p>}
        <div>
          <Button type="submit" size="sm" disabled={loading}>{loading ? "Updating…" : "Change password"}</Button>
        </div>
      </form>
    </Card>
  );
}

function GoogleIcon() {
  return (
    <svg style={{ width: 16, height: 16 }} viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
    </svg>
  );
}

function GithubIcon() {
  return (
    <svg style={{ width: 16, height: 16 }} fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
    </svg>
  );
}
