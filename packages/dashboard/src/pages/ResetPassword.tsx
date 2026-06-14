import { useState, useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { useTurnstile } from "./Login.js";
import "./login.css";

/**
 * Two modes:
 * 1. No token in URL → show "enter your email" form to request a reset link
 * 2. Token in URL → show "enter new password" form to complete the reset
 */
export function ResetPassword() {
  const params = new URLSearchParams(window.location.search);
  const token = params.get("token");
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c) => {
      setTurnstileSiteKey(c.turnstileSiteKey ?? null);
    }).catch(() => {});
  }, []);

  return token ? <SetNewPassword token={token} turnstileSiteKey={turnstileSiteKey} /> : <RequestReset turnstileSiteKey={turnstileSiteKey} />;
}

/** Shared branded shell so the reset pages match Login/Register. */
function AuthShell({ pullquote, eyebrow, title, lede, children }: {
  pullquote: string;
  eyebrow: string;
  title: React.ReactNode;
  lede?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="sodium-shell">
      <div style={{ position: "absolute", top: 16, right: 16, zIndex: 10 }}>
        <ThemeToggle className="vz-action-btn" />
      </div>
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

        <p className="login-pullquote">{pullquote}</p>

        <div className="login-card">
          <span className="vz-eyebrow">{eyebrow}</span>
          <h1>{title}</h1>
          {lede && <p className="lede">{lede}</p>}
          {children}
          <p className="register-prompt">
            <button type="button" onClick={() => { window.location.href = "/login"; }}>← Back to sign in</button>
          </p>
        </div>
      </div>
    </div>
  );
}

function RequestReset({ turnstileSiteKey }: { turnstileSiteKey: string | null }) {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { token: captchaToken, reset: resetCaptcha } = useTurnstile(turnstileSiteKey, turnstileRef);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !captchaToken) {
      setError("Please complete the captcha");
      return;
    }
    setError("");
    setLoading(true);
    const { error: err } = await authClient.requestPasswordReset({
      email,
      redirectTo: "/reset-password",
      fetchOptions: captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined,
    });
    setLoading(false);
    if (err) {
      setError(err.message ?? "Failed to send reset email");
      resetCaptcha();
    } else {
      setSent(true);
    }
  }

  return (
    <AuthShell
      pullquote="It happens to the best of us."
      eyebrow="Reset password"
      title={<>Forgot your <em>password?</em></>}
      lede={sent ? undefined : "Enter your email and we'll send a reset link."}
    >
      {sent ? (
        <p className="lede" role="status">
          Check your email for a reset link. If you don't see it, check your spam folder.
        </p>
      ) : (
        <form className="login-form" onSubmit={handleSubmit}>
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

          {turnstileSiteKey && <div ref={turnstileRef} />}

          {error && <p className="login-error" role="alert">{error}</p>}

          <button
            type="submit"
            className="vz-btn vz-btn--primary vz-btn--mono login-submit"
            disabled={loading || (!!turnstileSiteKey && !captchaToken)}
          >
            {loading ? "Sending…" : "Send reset link →"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}

function SetNewPassword({ token, turnstileSiteKey }: { token: string; turnstileSiteKey: string | null }) {
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [done, setDone] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { token: captchaToken, reset: resetCaptcha } = useTurnstile(turnstileSiteKey, turnstileRef);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password.length < 8) {
      setError("Password must be at least 8 characters");
      return;
    }
    if (password !== confirm) {
      setError("Passwords don't match");
      return;
    }
    if (turnstileSiteKey && !captchaToken) {
      setError("Please complete the captcha");
      return;
    }
    setError("");
    setLoading(true);
    const { error: err } = await authClient.resetPassword({
      newPassword: password,
      token,
      fetchOptions: captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined,
    });
    setLoading(false);
    if (err) {
      setError(err.message ?? "Failed to reset password");
      resetCaptcha();
    } else {
      setDone(true);
    }
  }

  return (
    <AuthShell
      pullquote="Almost there."
      eyebrow="Reset password"
      title={<>Set a new <em>password.</em></>}
    >
      {done ? (
        <>
          <p className="lede" role="status">Password updated.</p>
          <a href="/login" className="vz-btn vz-btn--primary vz-btn--mono login-submit" style={{ textDecoration: "none" }}>
            Sign in →
          </a>
        </>
      ) : (
        <form className="login-form" onSubmit={handleSubmit}>
          <label className="vz-field">
            <span className="vz-field__label">New password</span>
            <input
              type="password"
              className="vz-input"
              placeholder="Min 8 characters"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="new-password"
            />
          </label>

          <label className="vz-field">
            <span className="vz-field__label">Confirm password</span>
            <input
              type="password"
              className="vz-input"
              placeholder="Re-enter password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
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
            {loading ? "Updating…" : "Set new password →"}
          </button>
        </form>
      )}
    </AuthShell>
  );
}
