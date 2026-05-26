import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Login } from "./pages/Login.js";
import { Register } from "./pages/Register.js";
import { Settings } from "./pages/Settings.js";
import { ChatEmbed } from "./pages/ChatEmbed.js";
import { AcceptInvite } from "./pages/AcceptInvite.js";
import { ResetPassword } from "./pages/ResetPassword.js";
import { Setup } from "./pages/Setup.js";
import { Onboarding } from "./pages/Onboarding.js";
// In-product pages still offline on this branch while we redesign them
// onto the Sodium / Carbon shell:
// pages/{Workspace,MyAgents,Playbooks,Admin,Operations,Settings}.tsx
// remain on disk for reference; each gets ported one-by-one.
import { authClient } from "./lib/auth-client.js";
import { UserContext, type User } from "./contexts/UserContext.js";
import { AppConfigContext } from "./contexts/AppConfigContext.js";
import { AppShell } from "./components/AppShell.js";
import { track, initClickTracking } from "./lib/track.js";
import { EntitlementsProvider, getRoutes, registerDefaults, useEntitlements } from "./registry/index.js";

registerDefaults();

export function App() {
  const { data: session, isPending } = authClient.useSession();
  const [registrationEnabled, setRegistrationEnabled] = useState(false);
  const [setupNeeded, setSetupNeeded] = useState(false);
  const [ollamaEnabled, setOllamaEnabled] = useState(false);
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [appVersion, setAppVersion] = useState("dev");
  const [authProviders, setAuthProviders] = useState<{ google?: boolean; github?: boolean }>({});
  const [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null);
  const [marketingUrl, setMarketingUrl] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/config").then((r) => r.json()).then((c) => {
      setRegistrationEnabled(c.registrationEnabled ?? false);
      setSetupNeeded(c.setupNeeded ?? false);
      setOllamaEnabled(!!c.ollamaEnabled);
      setEmailEnabled(!!c.emailEnabled);
      if (c.version) { setAppVersion(c.version); (window as any).__VONZIO_VERSION = c.version; }
      if (c.maxTurns) { (window as any).__VONZIO_MAX_TURNS = c.maxTurns; }
      if (c.ollamaEnabled) { (window as any).__VONZIO_OLLAMA_ENABLED = true; }
      if (c.previewUrlTemplate) { (window as any).__VONZIO_PREVIEW_URL_TEMPLATE = c.previewUrlTemplate; }
      if (c.authProviders) setAuthProviders(c.authProviders);
      if (c.turnstileSiteKey) setTurnstileSiteKey(c.turnstileSiteKey);
      if (c.marketingUrl) setMarketingUrl(c.marketingUrl);
    }).catch(() => {}).finally(() => setConfigLoaded(true));
  }, []);

  // Public routes — no auth required
  if (window.location.pathname === "/chat" || window.location.pathname === "/invite" || window.location.pathname === "/reset-password") {
    return (
      <BrowserRouter>
        <Routes>
          <Route path="/chat" element={<ChatEmbed />} />
          <Route path="/invite" element={<AcceptInvite />} />
          <Route path="/reset-password" element={<ResetPassword />} />
        </Routes>
      </BrowserRouter>
    );
  }

  if (isPending) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  if (!session?.user) {
    // Wait for /api/config before deciding setup-vs-login — avoids a
    // single frame of "/login" flash on a fresh OSS instance.
    if (!configLoaded) {
      return (
        <div className="min-h-screen flex items-center justify-center bg-gray-50">
          <p className="text-sm text-gray-400">Loading...</p>
        </div>
      );
    }
    return (
      <BrowserRouter>
        <Routes>
          {setupNeeded && (
            <Route path="/setup" element={<Setup />} />
          )}
          <Route path="/login" element={<Login onLogin={() => { window.location.href = "/"; }} showRegister={registrationEnabled ? () => { window.location.href = "/register"; } : undefined} authProviders={authProviders} turnstileSiteKey={turnstileSiteKey} marketingUrl={marketingUrl} emailEnabled={emailEnabled} />} />
          {registrationEnabled && (
            <Route path="/register" element={<Register onRegister={() => { window.location.href = "/"; }} showLogin={() => { window.location.href = "/login"; }} authProviders={authProviders} turnstileSiteKey={turnstileSiteKey} />} />
          )}
          {/* Marketing/landing lives on the marketing domain (vonzio.com).
              Anything else hitting the app domain unauthenticated →
              /setup on a fresh OSS instance, /login otherwise. */}
          <Route path="*" element={<Navigate to={setupNeeded ? "/setup" : "/login"} replace />} />
        </Routes>
      </BrowserRouter>
    );
  }

  const user: User = {
    id: session.user.id,
    email: session.user.email,
    name: session.user.name,
    role: (session.user as Record<string, unknown>).role as string ?? "user",
    feature_flags: ((session.user as Record<string, unknown>).featureFlags ?? (session.user as Record<string, unknown>).feature_flags ?? "") as string,
  };

  return (
    <AppConfigContext.Provider value={{ registrationEnabled }}>
      <UserContext.Provider value={user}>
        <EntitlementsGate>
          <AppRoutes user={user} registrationEnabled={registrationEnabled} ollamaEnabled={ollamaEnabled} />
        </EntitlementsGate>
      </UserContext.Provider>
    </AppConfigContext.Provider>
  );
}

// Fetches /api/me on mount and renders children with the returned
// entitlements. On 401 (session expired server-side while Better Auth's
// client cache still thinks we're signed in) full-reload to /login so
// the auth tree can pick it up. On other errors surface a real failure
// state with a retry button — silently defaulting to ["self_hosted"]
// would demote paying users to an OSS view on any transient hiccup.
type GateState =
  | { status: "loading" }
  | { status: "ready"; entitlements: string[] }
  | { status: "error" };

function EntitlementsGate({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<GateState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const ctrl = new AbortController();
    setState({ status: "loading" });
    fetch("/api/me", { credentials: "include", signal: ctrl.signal })
      .then(async (r) => {
        if (r.status === 401) {
          window.location.href = "/login";
          return;
        }
        if (!r.ok) throw new Error(`/api/me HTTP ${r.status}`);
        const data = (await r.json()) as { entitlements?: unknown };
        if (!Array.isArray(data.entitlements)) throw new Error("/api/me: malformed entitlements");
        setState({ status: "ready", entitlements: data.entitlements as string[] });
      })
      .catch((err: unknown) => {
        if (err instanceof Error && err.name === "AbortError") return;
        setState({ status: "error" });
      });
    return () => ctrl.abort();
  }, [attempt]);
  if (state.status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }
  if (state.status === "error") {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center bg-gray-50 gap-3 px-6">
        <p className="text-sm text-gray-600">Couldn't reach the server. Check your connection.</p>
        <button
          type="button"
          onClick={() => setAttempt((a) => a + 1)}
          className="text-sm underline text-gray-700 hover:text-gray-900"
        >
          Try again
        </button>
      </div>
    );
  }
  return <EntitlementsProvider value={state.entitlements}>{children}</EntitlementsProvider>;
}

function AppRoutes({ user, registrationEnabled, ollamaEnabled }: { user: User; registrationEnabled: boolean; ollamaEnabled: boolean }) {
  // Fetch profile count to decide whether to route into the onboarding
  // wizard. Null while loading so we don't redirect off the requested
  // page before the answer is in.
  const [profileCount, setProfileCount] = useState<number | null>(null);
  useEffect(() => {
    fetch("/v1/profiles", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : []))
      .then((p) => setProfileCount(Array.isArray(p) ? p.length : 0))
      .catch(() => setProfileCount(0));
  }, []);

  if (profileCount === null) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <p className="text-sm text-gray-400">Loading...</p>
      </div>
    );
  }

  return (
    <BrowserRouter>
      <AppRoutesGuard
        ollamaEnabled={ollamaEnabled}
        needsOnboarding={profileCount === 0}
      />
    </BrowserRouter>
  );
}

function AppRoutesGuard({ ollamaEnabled, needsOnboarding }: { ollamaEnabled: boolean; needsOnboarding: boolean }) {
  const location = useLocation();
  const entitlements = useEntitlements();
  useEffect(() => { initClickTracking(); }, []);
  useEffect(() => { track("ui.page_view", { path: location.pathname }); }, [location.pathname]);

  // OSS onboarding: signed in but no profile yet. Route into the
  // wizard; most paths redirect there too until they're done. The
  // wizard reload-navigates to `/` on success, which re-runs the
  // profile-count fetch above and lands on the workspace normally.
  //
  // /settings is an explicit escape hatch — the wizard's footer points
  // users there for manual configuration. If we redirect /settings to
  // /onboarding too, users following that link land back at the wizard
  // (trap). Mounting Settings alongside Onboarding when
  // needsOnboarding=true lets power users wire keys/agents directly;
  // when they save a profile there, the next reload lands them in the
  // workspace normally.
  if (needsOnboarding) {
    return (
      <Routes>
        <Route path="/onboarding" element={<Onboarding ollamaEnabled={ollamaEnabled} onDone={() => { window.location.href = "/"; }} />} />
        <Route path="/settings" element={<AppShell><Settings /></AppShell>} />
        <Route path="*" element={<Navigate to="/onboarding" replace />} />
      </Routes>
    );
  }

  const routes = getRoutes().filter(
    (r) => !r.entitlement || entitlements.includes(r.entitlement),
  );

  return (
    <Routes>
      {routes.map((r) => (
        <Route
          key={r.id}
          path={r.path}
          element={r.layout === "shell" ? <AppShell>{r.element}</AppShell> : r.element}
        />
      ))}
      {/* Anything else → Workspace. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
