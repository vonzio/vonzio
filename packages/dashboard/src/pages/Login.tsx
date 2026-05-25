import { useState, useEffect, useRef, useCallback } from "react";
import { authClient } from "../lib/auth-client.js";
import { Toggle } from "../brand/components.js";
import "./login.css";

declare global {
  interface Window {
    turnstile?: {
      render: (container: string | HTMLElement, options: Record<string, unknown>) => string;
      reset: (widgetId: string) => void;
      remove: (widgetId: string) => void;
    };
  }
}

interface Props {
  onLogin: () => void;
  showRegister?: () => void;
  authProviders?: { google?: boolean; github?: boolean };
  turnstileSiteKey?: string | null;
  marketingUrl?: string | null;
  /**
   * False on OSS instances without Resend configured — hides the
   * "Forgot?" link since the reset email has no way to reach the user.
   */
  emailEnabled?: boolean;
}

function useTurnstile(siteKey: string | null | undefined, containerRef: React.RefObject<HTMLDivElement | null>) {
  const [token, setToken] = useState<string | null>(null);
  const widgetIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!siteKey || !containerRef.current) return;

    function renderWidget() {
      if (!window.turnstile || !containerRef.current) return;
      if (widgetIdRef.current) {
        window.turnstile.remove(widgetIdRef.current);
      }
      widgetIdRef.current = window.turnstile.render(containerRef.current, {
        sitekey: siteKey,
        callback: (t: string) => setToken(t),
        "expired-callback": () => setToken(null),
        theme: "dark",
        size: "flexible",
      });
    }

    if (window.turnstile) {
      renderWidget();
    } else {
      const script = document.createElement("script");
      script.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
      script.async = true;
      script.onload = renderWidget;
      document.head.appendChild(script);
    }

    return () => {
      if (widgetIdRef.current && window.turnstile) {
        window.turnstile.remove(widgetIdRef.current);
        widgetIdRef.current = null;
      }
    };
  }, [siteKey]);

  const reset = useCallback(() => {
    setToken(null);
    if (widgetIdRef.current && window.turnstile) {
      window.turnstile.reset(widgetIdRef.current);
    }
  }, []);

  return { token, reset };
}

export function Login({ onLogin, showRegister, authProviders, turnstileSiteKey, marketingUrl, emailEnabled }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [rememberMe, setRememberMe] = useState(true);
  const [error, setError] = useState(() => {
    const params = new URLSearchParams(window.location.search);
    const authError = params.get("auth_error");
    if (authError) {
      window.history.replaceState({}, "", window.location.pathname);
      return authError;
    }
    return "";
  });
  const [loading, setLoading] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { token: captchaToken, reset: resetCaptcha } = useTurnstile(turnstileSiteKey, turnstileRef);

  const hasOAuth = authProviders?.google || authProviders?.github;
  // Footer Privacy/Terms point at the marketing site. Fall back to the
  // dashboard's static stubs if the server didn't expose MARKETING_URL.
  const privacyHref = marketingUrl ? `${marketingUrl}/privacy` : "/privacy.html";
  const termsHref = marketingUrl ? `${marketingUrl}/terms` : "/terms.html";
  // Brand logo + the explicit back link in the footer both lead to the
  // marketing site. When MARKETING_URL isn't configured we fall back to
  // "/" so the brand still acts as "home" instead of being a dead link.
  const homeHref = marketingUrl ?? "/";

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (turnstileSiteKey && !captchaToken) {
      setError("Please complete the captcha");
      return;
    }
    setError("");
    setLoading(true);
    const { error: authError } = await authClient.signIn.email({
      email,
      password,
      rememberMe,
      fetchOptions: captchaToken ? { headers: { "x-captcha-response": captchaToken } } : undefined,
    });
    setLoading(false);
    if (authError) {
      setError(authError.message ?? "Login failed");
      resetCaptcha();
    } else {
      onLogin();
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    await authClient.signIn.social({ provider, callbackURL: "/" });
  }

  return (
    <div className="sodium-shell" data-surface="carbon">
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

        <p className="login-pullquote">A small ritual, not a surveillance regime.</p>

        <div className="login-card">
          <span className="vz-eyebrow">Sign in</span>
          <h1>Welcome <em>back.</em></h1>
          <p className="lede">Pick up where you left off.</p>

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
              <span className="password-row">
                <span className="vz-field__label">Password</span>
                {emailEnabled && <a className="forgot-link" href="/reset-password">Forgot?</a>}
              </span>
              <input
                type="password"
                className="vz-input"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoComplete="current-password"
              />
            </label>

            <Toggle checked={rememberMe} onChange={setRememberMe}>
              Keep me signed in on this device
            </Toggle>

            {turnstileSiteKey && <div ref={turnstileRef} />}

            {error && <p className="login-error" role="alert">{error}</p>}

            <button
              type="submit"
              className="vz-btn vz-btn--primary vz-btn--mono login-submit"
              disabled={loading || (!!turnstileSiteKey && !captchaToken)}
            >
              {loading ? "Signing in…" : "Sign in →"}
            </button>

            <p className="login-tos">
              By continuing, you agree to our{" "}
              <a href={termsHref}>Terms</a> and <a href={privacyHref}>Privacy</a>.
            </p>
          </form>

          {showRegister && (
            <p className="register-prompt">
              No account?{" "}
              <button type="button" onClick={showRegister}>Register</button>
            </p>
          )}
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

export { useTurnstile };
