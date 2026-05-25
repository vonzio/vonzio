import { useState, useEffect, useRef } from "react";
import { authClient } from "../lib/auth-client.js";
import { useTurnstile } from "./Login.js";

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

function VLogo() {
  return (
    <svg viewBox="0 0 512 512" className="w-10 h-10">
      <polyline points="155,160 256,290 347,160"
        fill="none" stroke="white" strokeWidth="50"
        strokeLinecap="round" strokeLinejoin="round"/>
      <rect x="190" y="330" width="132" height="28" rx="14" fill="#00BFA5"/>
    </svg>
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
    <div className="min-h-screen flex items-center justify-center bg-primary px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <VLogo />
          <h1 className="text-2xl font-bold text-white">Reset password</h1>
        </div>

        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8">
          {sent ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-white/80">Check your email for a reset link.</p>
              <p className="text-xs text-white/40">If you don't see it, check your spam folder.</p>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <p className="text-sm text-white/60 mb-4">Enter your email and we'll send you a reset link.</p>
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1.5">Email</label>
                <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" required />
              </div>
              {turnstileSiteKey && <div ref={turnstileRef} />}
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={loading || (!!turnstileSiteKey && !captchaToken)}
                className="w-full py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer">
                {loading ? "Sending..." : "Send Reset Link"}
              </button>
            </form>
          )}
        </div>

        <p className="text-center text-sm text-white/40 mt-5">
          <a href="/login" className="text-accent hover:text-accent/80 transition-colors">Back to login</a>
        </p>
      </div>
    </div>
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
    <div className="min-h-screen flex items-center justify-center bg-primary px-4">
      <div className="w-full max-w-sm">
        <div className="flex flex-col items-center gap-3 mb-8">
          <VLogo />
          <h1 className="text-2xl font-bold text-white">New password</h1>
        </div>

        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8">
          {done ? (
            <div className="text-center space-y-3">
              <p className="text-sm text-white/80">Password updated.</p>
              <a href="/login" className="inline-block mt-2 px-6 py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 transition-colors">Sign In</a>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1.5">New password</label>
                <input type="password" placeholder="Min 8 characters" value={password} onChange={(e) => setPassword(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" required />
              </div>
              <div>
                <label className="block text-sm font-medium text-white/70 mb-1.5">Confirm password</label>
                <input type="password" placeholder="Confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)}
                  className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" required />
              </div>
              {turnstileSiteKey && <div ref={turnstileRef} />}
              {error && <p className="text-red-400 text-sm">{error}</p>}
              <button type="submit" disabled={loading || (!!turnstileSiteKey && !captchaToken)}
                className="w-full py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer">
                {loading ? "Updating..." : "Set New Password"}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
