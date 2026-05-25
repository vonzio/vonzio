import { useState, type FormEvent } from "react";
import "./login.css";

/**
 * OSS first-run setup wizard. Renders when REGISTRATION_ENABLED=false and
 * no users exist in the database. POSTs to /api/setup to create the lone
 * admin account, then full-reloads to /login. The wizard route 409s for
 * any subsequent visit; users land on /login from then on.
 *
 * Visually mirrors pages/Login.tsx (same .sodium-shell + login.css) so the
 * first impression matches the rest of the dashboard chrome.
 */
export function Setup() {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/setup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, name, password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // Full reload so /api/config refetches setupNeeded=false and the
      // catch-all stops redirecting back here.
      window.location.href = "/login";
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
      setSubmitting(false);
    }
  }

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

        <p className="login-pullquote">Your instance. Your data. Your terms.</p>

        <div className="login-card">
          <span className="vz-eyebrow">First-run setup</span>
          <h1>Welcome <em>to vonzio.</em></h1>
          <p className="lede">
            This instance has no users yet. Create your admin account — this is the only signup. After this, the instance is locked to you.
          </p>

          <form className="login-form" onSubmit={onSubmit}>
            <label className="vz-field">
              <span className="vz-field__label">Name</span>
              <input
                type="text"
                className="vz-input"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                autoComplete="name"
              />
            </label>

            <label className="vz-field">
              <span className="vz-field__label">Email</span>
              <input
                type="email"
                className="vz-input"
                placeholder="you@company.com"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoComplete="email"
              />
            </label>

            <label className="vz-field">
              <span className="vz-field__label">Password</span>
              <input
                type="password"
                className="vz-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
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
              {submitting ? "Creating…" : "Create admin account →"}
            </button>

            <p className="login-tos">
              Minimum 8 characters. Pick something only you will remember — this is your only credential.
            </p>
          </form>
        </div>

        <div className="login-footer">
          <span className="status">tls 1.3 · zero-data-retention</span>
        </div>
      </div>
    </div>
  );
}
