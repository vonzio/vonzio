import { useState, useRef } from "react";
import { authClient } from "../lib/auth-client.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { useTurnstile } from "./Login.js";
import "./login.css";

interface Props {
  onRegister: () => void;
  showLogin: () => void;
  authProviders?: { google?: boolean; github?: boolean };
  turnstileSiteKey?: string | null;
  marketingUrl?: string | null;
}

export function Register({ onRegister, showLogin, authProviders, turnstileSiteKey, marketingUrl }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { token: captchaToken, reset: resetCaptcha } = useTurnstile(turnstileSiteKey, turnstileRef);

  // ?next=<relative path> — where to land after signup. Same-origin
  // relative paths only (leading "/", not "//") so the param can't be
  // abused as an open redirect. Used by acquisition surfaces (e.g. the
  // official Telegram bot's "Create an account" button deep-links to
  // /register?next=/settings%23telegram so the user finishes pairing).
  const nextParam = (() => {
    try {
      const raw = new URLSearchParams(window.location.search).get("next");
      if (raw && raw.startsWith("/") && !raw.startsWith("//")) return raw;
    } catch { /* SSR/parse — ignore */ }
    return null;
  })();

  const hasOAuth = authProviders?.google || authProviders?.github;
  const privacyHref = marketingUrl ? `${marketingUrl}/privacy` : "/privacy.html";
  const termsHref = marketingUrl ? `${marketingUrl}/terms` : "/terms.html";
  const homeHref = marketingUrl ?? "/";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !captchaToken) {
      setError("Please complete the captcha");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.signUp.email({
      email,
      password,
      name,
      fetchOptions: captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined,
    });
    setLoading(false);
    if (authError) {
      setError(authError.message ?? "Registration failed");
      resetCaptcha();
    } else {
      if (nextParam) {
        window.location.assign(nextParam);
        return;
      }
      onRegister();
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    await authClient.signIn.social({ provider, callbackURL: nextParam ?? "/" });
  }

  return (
    <div className="sodium-shell">
      <div style={{ position: "absolute", top: 16, right: 16, zIndex: 10 }}>
        <ThemeToggle className="vz-action-btn" />
      </div>
      <div className="login-stage">
        <a href={homeHref} className="login-brand" aria-label="vonzio">
          <span className="vm" aria-hidden="true">
            <svg width="18" height="18" viewBox="0 0 64 64">
              <path d="M18 22 L32 44 L46 22" fill="none" stroke="var(--vz-sodium)" strokeWidth="6.5" strokeLinecap="round" strokeLinejoin="round" />
              <rect x="22" y="49" width="20" height="3.5" rx="1.75" fill="var(--vz-sodium)" />
            </svg>
          </span>
          <span><span className="vletter">v</span>onzio</span>
        </a>

        <p className="login-pullquote">Spin up your first agent in minutes.</p>

        <div className="login-card">
          <span className="vz-eyebrow">Create account</span>
          <h1>Get <em>started.</em></h1>
          <p className="lede">One account, every workspace.</p>

          {hasOAuth && (
            <>
              <div className="oauth-stack">
                {authProviders?.github && (
                  <button type="button" className="oauth-btn" onClick={() => handleOAuth("github")}>
                    <svg fill="currentColor" viewBox="0 0 24 24" aria-hidden="true">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z" />
                    </svg>
                    Continue with GitHub
                  </button>
                )}
                {authProviders?.google && (
                  <button type="button" className="oauth-btn" onClick={() => handleOAuth("google")}>
                    <svg viewBox="0 0 24 24" aria-hidden="true">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
                    </svg>
                    Continue with Google
                  </button>
                )}
              </div>
              <div className="oauth-divider">or with email</div>
            </>
          )}

          <form className="login-form" onSubmit={handleSubmit}>
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
                placeholder="Min 8 characters"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={8}
                required
                autoComplete="new-password"
              />
            </label>

            {turnstileSiteKey && <div ref={turnstileRef} />}

            {error && <p className="login-error" role="alert">{error}</p>}

            <button
              type="submit"
              className="vz-btn vz-btn--primary vz-btn--mono login-submit"
              disabled={loading || (!!turnstileSiteKey && !captchaToken)}
            >
              {loading ? "Creating account…" : "Create account →"}
            </button>

            <p className="login-tos">
              By continuing, you agree to our{" "}
              <a href={termsHref}>Terms</a> and <a href={privacyHref}>Privacy</a>.
            </p>
          </form>

          <p className="register-prompt">
            Already have an account?{" "}
            <button type="button" onClick={showLogin}>Sign in</button>
          </p>
        </div>

        <div className="login-footer">
          <span className="status">tls 1.3 · zero-data-retention</span>
          <span className="links">
            <a href={homeHref} className="back-link">← Back to home</a>
            <span aria-hidden="true">·</span>
            <a href={privacyHref}>Privacy</a>
            <span aria-hidden="true">·</span>
            <a href={termsHref}>Terms</a>
          </span>
        </div>
      </div>
    </div>
  );
}
