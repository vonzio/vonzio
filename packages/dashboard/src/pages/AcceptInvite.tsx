import { useState, useEffect, type FormEvent } from "react";

/**
 * Accept-invite landing. Matches the Login page's brand surface
 * (sodium-shell + login-stage + vz-field/vz-btn classes) so a user
 * walking in from an admin invite doesn't get jolted by a different
 * visual language than the rest of the auth flow.
 */
function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="sodium-shell" data-surface="carbon">
      <div className="login-stage">
        <a href="/" className="login-brand" aria-label="vonzio">
          <span className="vm" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 64 64">
              <path d="M18 22 L32 44 L46 22" fill="none" stroke="var(--vz-sodium)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="var(--vz-sodium)" />
            </svg>
          </span>
          <span><span className="vletter">v</span>onzio</span>
        </a>
        {children}
      </div>
    </div>
  );
}

export function AcceptInvite() {
  const token = new URLSearchParams(window.location.search).get("token") ?? "";
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return; }
    fetch(`/api/invite/validate?token=${encodeURIComponent(token)}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json() as Promise<{ email: string }>; })
      .then((data) => { setEmail(data.email); setLoading(false); })
      .catch(() => { setInvalid(true); setLoading(false); });
  }, [token]);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError("Passwords don't match."); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters."); return; }
    setError("");
    setSubmitting(true);
    try {
      const res = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json() as { error?: string };
      if (!res.ok) throw new Error(data.error ?? "Failed to create account");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account.");
    } finally {
      setSubmitting(false);
    }
  }

  if (loading) {
    return (
      <AuthShell>
        <div className="login-card">
          <p className="lede" style={{ opacity: 0.7 }}>Validating invite…</p>
        </div>
      </AuthShell>
    );
  }

  if (invalid) {
    return (
      <AuthShell>
        <div className="login-card">
          <span className="vz-eyebrow">Invite</span>
          <h1>Invalid <em>link.</em></h1>
          <p className="lede">This invite is invalid or has expired. Ask your admin for a new one.</p>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <div className="login-card">
          <span className="vz-eyebrow">Welcome</span>
          <h1>Account <em>ready.</em></h1>
          <p className="lede">You can sign in with the email and password you just set.</p>
          <a href="/" className="vz-btn vz-btn--primary vz-btn--mono login-submit" style={{ textAlign: "center", textDecoration: "none" }}>
            Go to sign in →
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <p className="login-pullquote">The runtime for production agents.</p>

      <div className="login-card">
        <span className="vz-eyebrow">Invite</span>
        <h1>Set up your <em>account.</em></h1>
        <p className="lede">A few details and you're in.</p>

        <form className="login-form" onSubmit={handleSubmit}>
          <label className="vz-field">
            <span className="vz-field__label">Email</span>
            <input
              type="email"
              className="vz-input"
              value={email}
              disabled
              autoComplete="email"
            />
          </label>

          <label className="vz-field">
            <span className="vz-field__label">Name</span>
            <input
              type="text"
              className="vz-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Your name"
              required
              autoComplete="name"
            />
          </label>

          <label className="vz-field">
            <span className="vz-field__label">Password</span>
            <input
              type="password"
              className="vz-input"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="At least 8 characters"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>

          <label className="vz-field">
            <span className="vz-field__label">Confirm password</span>
            <input
              type="password"
              className="vz-input"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="••••••••"
              required
              minLength={8}
              autoComplete="new-password"
            />
          </label>

          {error && <p className="login-error" role="alert">{error}</p>}

          <button
            type="submit"
            className="vz-btn vz-btn--primary vz-btn--mono login-submit"
            disabled={submitting}
          >
            {submitting ? "Creating account…" : "Create account →"}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
