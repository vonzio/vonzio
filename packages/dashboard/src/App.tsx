import { useState, useEffect } from "react";
import { BrowserRouter, Routes, Route, Navigate, useLocation } from "react-router-dom";
import { Login } from "./pages/Login.js";
import { Register } from "./pages/Register.js";
import { Placeholder } from "./pages/Placeholder.js";
import Memories from "./pages/Memories.js";
import { Playbooks } from "./pages/Playbooks.js";
import { Admin } from "./pages/Admin.js";
import { Operations } from "./pages/Operations.js";
import { MyAgents } from "./pages/MyAgents.js";
import { EditAgent } from "./pages/EditAgent.js";
import { Settings } from "./pages/Settings.js";
import { Workspace } from "./pages/Workspace.js";
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
        <AppRoutes user={user} registrationEnabled={registrationEnabled} ollamaEnabled={ollamaEnabled} />
      </UserContext.Provider>
    </AppConfigContext.Provider>
  );
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
        user={user}
        registrationEnabled={registrationEnabled}
        ollamaEnabled={ollamaEnabled}
        needsOnboarding={profileCount === 0}
      />
    </BrowserRouter>
  );
}

function AppRoutesGuard({ user, registrationEnabled, ollamaEnabled, needsOnboarding }: { user: User; registrationEnabled: boolean; ollamaEnabled: boolean; needsOnboarding: boolean }) {
  const location = useLocation();
  useEffect(() => { initClickTracking(); }, []);
  useEffect(() => { track("ui.page_view", { path: location.pathname }); }, [location.pathname]);
  const isAdmin = user.role === "admin";

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

  // Phase-1 placeholders. Each route renders inside the new AppShell so the
  // chrome (rail, topbar, statusbar) is exercised; per-page redesigns swap
  // the Placeholder for the real page in subsequent commits.
  return (
    <Routes>
      <Route path="/" element={<AppShell><Workspace /></AppShell>} />
      <Route path="/w/:id" element={<AppShell><Workspace /></AppShell>} />
      <Route path="/agents" element={<AppShell><MyAgents /></AppShell>} />
      <Route path="/agents/new" element={<AppShell><EditAgent /></AppShell>} />
      <Route path="/agents/:id/edit" element={<AppShell><EditAgent /></AppShell>} />
      <Route path="/playbooks" element={<AppShell><Playbooks /></AppShell>} />
      <Route path="/memories" element={<AppShell><Memories /></AppShell>} />
      <Route path="/settings" element={<AppShell><Settings /></AppShell>} />
      {isAdmin && registrationEnabled && (
        <Route path="/admin" element={<AppShell><Admin /></AppShell>} />
      )}
      {isAdmin && (
        <Route path="/ops" element={<AppShell><Operations /></AppShell>} />
      )}

      {/* Anything else → Workspace. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
