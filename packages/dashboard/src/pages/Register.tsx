import { useState, useRef } from "react";
import { authClient } from "../lib/auth-client.js";
import { useTurnstile } from "./Login.js";

interface Props {
  onRegister: () => void;
  showLogin: () => void;
  authProviders?: { google?: boolean; github?: boolean };
  turnstileSiteKey?: string | null;
}

export function Register({ onRegister, showLogin, authProviders, turnstileSiteKey }: Props) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const turnstileRef = useRef<HTMLDivElement>(null);
  const { token: captchaToken, reset: resetCaptcha } = useTurnstile(turnstileSiteKey, turnstileRef);

  const hasOAuth = authProviders?.google || authProviders?.github;

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
      onRegister();
    }
  }

  async function handleOAuth(provider: "google" | "github") {
    await authClient.signIn.social({ provider, callbackURL: "/" });
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-primary px-4">
      <div className="w-full max-w-sm">
        {/* Logo + tagline */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <div className="w-14 h-14 rounded-2xl bg-white/10 backdrop-blur flex items-center justify-center">
            <svg viewBox="0 0 512 512" className="w-8 h-8">
              <polyline points="155,160 256,290 347,160"
                fill="none" stroke="white" strokeWidth="50"
                strokeLinecap="round" strokeLinejoin="round"/>
              <rect x="190" y="330" width="132" height="28" rx="14" fill="#00BFA5"/>
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">vonzio</h1>
          <p className="text-sm text-white/50">Create your account</p>
        </div>

        {/* Form card */}
        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8">
          {/* OAuth buttons */}
          {hasOAuth && (
            <>
              <div className="space-y-2.5">
                {authProviders?.google && (
                  <button
                    onClick={() => handleOAuth("google")}
                    className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 bg-white text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-50 transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" viewBox="0 0 24 24">
                      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/>
                      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
                      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
                    </svg>
                    Continue with Google
                  </button>
                )}
                {authProviders?.github && (
                  <button
                    onClick={() => handleOAuth("github")}
                    className="w-full flex items-center justify-center gap-2.5 py-2.5 px-4 bg-white/10 text-white text-sm font-medium rounded-lg border border-white/10 hover:bg-white/15 transition-colors cursor-pointer"
                  >
                    <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 0c-6.626 0-12 5.373-12 12 0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23.957-.266 1.983-.399 3.003-.404 1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576 4.765-1.589 8.199-6.086 8.199-11.386 0-6.627-5.373-12-12-12z"/>
                    </svg>
                    Continue with GitHub
                  </button>
                )}
              </div>

              <div className="flex items-center gap-3 my-5">
                <div className="flex-1 h-px bg-white/10" />
                <span className="text-xs text-white/30">or</span>
                <div className="flex-1 h-px bg-white/10" />
              </div>
            </>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1.5">Name</label>
              <input type="text" placeholder="Your name" value={name} onChange={(e) => setName(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1.5">Email</label>
              <input type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" required />
            </div>
            <div>
              <label className="block text-sm font-medium text-white/70 mb-1.5">Password</label>
              <input type="password" placeholder="Min 8 characters" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors" minLength={8} required />
            </div>
            {/* Turnstile widget */}
            {turnstileSiteKey && <div ref={turnstileRef} />}
            {error && <p className="text-red-400 text-sm">{error}</p>}
            <button type="submit" disabled={loading || (!!turnstileSiteKey && !captchaToken)}
              className="w-full py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer">
              {loading ? "Creating account..." : "Create Account"}
            </button>
          </form>
        </div>

        <p className="text-center text-sm text-white/40 mt-5">
          Already have an account?{" "}
          <button onClick={showLogin} className="text-accent hover:text-accent/80 cursor-pointer transition-colors">Sign in</button>
        </p>
      </div>
    </div>
  );
}
