import { useState, useEffect } from "react";

function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-primary px-4">
      <div className="w-full max-w-sm">
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
        </div>
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
  const [invalid, setInvalid] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) { setInvalid(true); setLoading(false); return; }
    fetch(`/api/invite/validate?token=${encodeURIComponent(token)}`)
      .then((r) => { if (!r.ok) throw new Error(); return r.json(); })
      .then((data) => { setEmail(data.email); setLoading(false); })
      .catch(() => { setInvalid(true); setLoading(false); });
  }, [token]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (password !== confirmPassword) { setError("Passwords don't match"); return; }
    if (password.length < 8) { setError("Password must be at least 8 characters"); return; }
    setError("");
    setLoading(true);

    try {
      const res = await fetch("/api/invite/accept", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, name, password }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed");
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create account");
    } finally {
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <AuthShell>
        <p className="text-sm text-white/40 text-center">Validating invite...</p>
      </AuthShell>
    );
  }

  if (invalid) {
    return (
      <AuthShell>
        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8 text-center">
          <h2 className="text-lg font-semibold text-white mb-2">Invalid Invite</h2>
          <p className="text-sm text-white/50">This invite link is invalid or has expired. Please ask your admin for a new one.</p>
        </div>
      </AuthShell>
    );
  }

  if (done) {
    return (
      <AuthShell>
        <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8 text-center">
          <h2 className="text-lg font-semibold text-white mb-2">Account Created</h2>
          <p className="text-sm text-white/50 mb-6">You can now log in with your email and password.</p>
          <a href="/" className="inline-block px-6 py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 transition-colors">
            Go to Login
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <div className="bg-white/5 backdrop-blur border border-white/10 rounded-2xl p-6 sm:p-8">
        <p className="text-center text-sm text-white/50 mb-6">Set up your account</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-white/70 mb-1.5">Email</label>
            <input type="email" value={email} disabled
              className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white/50" />
          </div>
          <div>
            <label className="block text-sm font-medium text-white/70 mb-1.5">Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors"
              placeholder="Your name" required />
          </div>
          <div>
            <label className="block text-sm font-medium text-white/70 mb-1.5">Password</label>
            <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors"
              placeholder="Min 8 characters" required minLength={8} />
          </div>
          <div>
            <label className="block text-sm font-medium text-white/70 mb-1.5">Confirm Password</label>
            <input type="password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border border-white/10 rounded-lg bg-white/5 text-white placeholder:text-white/30 focus:outline-none focus:ring-2 focus:ring-accent focus:border-transparent transition-colors"
              placeholder="Confirm password" required minLength={8} />
          </div>
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button type="submit" disabled={loading}
            className="w-full py-2.5 bg-accent text-white text-sm font-medium rounded-lg hover:bg-accent/90 disabled:opacity-50 transition-colors cursor-pointer">
            {loading ? "Creating account..." : "Create Account"}
          </button>
        </form>
      </div>
    </AuthShell>
  );
}
