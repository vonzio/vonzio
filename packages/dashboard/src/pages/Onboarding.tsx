import { useState, useEffect, type FormEvent } from "react";
import { AlertTriangle } from "lucide-react";
import { PROVIDER_CATALOG, type ProviderInfo } from "@vonzio/shared";
import { createProfile } from "../api/client.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import { useChatGptSignIn, ChatGptSignInPanel } from "../components/ChatGptSignIn.js";
import { useClaudeSignIn, ClaudeSignInPanel } from "../components/ClaudeSignIn.js";
import { useEntitlements } from "../registry/index.js";
import "./login.css";

/**
 * OSS post-signup onboarding wizard. Renders when a signed-in user has
 * zero profiles. Two steps:
 *   1. Pick credential — Anthropic API key, OpenAI (or OpenAI-compatible)
 *      key, or Ollama Cloud API key. All submit to /v1/anthropic-keys with
 *      the right `provider` value; the endpoint auto-creates a default
 *      profile bound to that key with matching provider
 *      (routes/user-resources.ts).
 *   2. Pick default model — fetches /v1/profiles/:id/models so the user
 *      sees what the key actually has access to (Anthropic returns
 *      claude-*, Ollama returns the user's available Ollama Cloud
 *      models), then PATCHes the profile with the chosen model.
 *
 * Reuses the same .sodium-shell + login.css chrome as Login/Setup so the
 * post-signup journey looks like one cohesive flow.
 */

// Provider metadata comes from the shared PROVIDER_CATALOG (single source of
// truth) so this wizard, the first-key modal, and Settings → keys never drift.
type CredentialKind = ProviderInfo["kind"];

const CRED_META = Object.fromEntries(
  PROVIDER_CATALOG.map((p) => [p.kind, p]),
) as Record<CredentialKind, ProviderInfo>;

interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama" | "openai";
}

export function Onboarding({ onDone }: { onDone: () => void; ollamaEnabled?: boolean }) {
  // ollamaEnabled (server-side OLLAMA_ENABLED flag) is no longer
  // needed to gate the Ollama Cloud option — Ollama Cloud is a hosted
  // service with API keys and works regardless of whether the server
  // would talk to a local Ollama daemon. Prop kept for API stability
  // until the local-Ollama path lands.
  const [step, setStep] = useState<"credential" | "model">("credential");
  const [profileId, setProfileId] = useState<string | null>(null);
  const [kind, setKind] = useState<CredentialKind>("anthropic_key");
  const [secret, setSecret] = useState("");
  // OpenAI-compatible endpoint override; only used when kind === "openai",
  // and behind an "Advanced" disclosure so the default is OpenAI itself.
  const [baseUrl, setBaseUrl] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [skipping, setSkipping] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cautious-user escape hatch: create a keyless default agent and enter the
  // app. The workspace's no-key state then prompts to add a key when ready.
  async function onSkip() {
    setError(null);
    setSkipping(true);
    try {
      await createProfile({ name: "default" });
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't set up a workspace to explore.");
      setSkipping(false);
    }
  }

  // Both credential paths (pasted key + ChatGPT OAuth) auto-create the
  // default profile server-side; fetch it so step 2 can ask for
  // /v1/profiles/:id/models with the right id.
  async function advanceToModelStep() {
    const profilesRes = await fetch("/v1/profiles", { credentials: "include" });
    const profiles = (await profilesRes.json()) as Array<{ id: string; user_id: string | null }>;
    const own = profiles.find((p) => p.user_id);
    if (!own) throw new Error("Default agent was not created — please retry.");
    setProfileId(own.id);
    setStep("model");
  }

  // The ChatGPT device-login's poll route created the credential + default
  // profile (same attachKeyToProfile as the paste path) — just advance.
  function onOauthConnected() {
    advanceToModelStep().catch((err) => {
      setError(err instanceof Error ? err.message : "Setup failed");
    });
  }

  async function onCredentialSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    const trimmed = secret.trim();
    if (!trimmed) {
      setError("Paste your credential to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const meta = CRED_META[kind];
      const res = await fetch("/v1/anthropic-keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          name: meta.defaultKeyName,
          provider: meta.provider,
          api_key: trimmed,
          ...(kind === "openai" ? { base_url: baseUrl.trim() || undefined } : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      await advanceToModelStep();
      setSubmitting(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Setup failed");
      setSubmitting(false);
    }
  }

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

        <p className="login-pullquote">One credential, one default agent. You're 30 seconds away.</p>

        {step === "credential" ? (
          <CredentialStep
            kind={kind}
            setKind={setKind}
            secret={secret}
            setSecret={setSecret}
            baseUrl={baseUrl}
            setBaseUrl={setBaseUrl}
            showAdvanced={showAdvanced}
            setShowAdvanced={setShowAdvanced}
            submitting={submitting}
            error={error}
            onSubmit={onCredentialSubmit}
            onOauthConnected={onOauthConnected}
            onErrorClear={() => setError(null)}
            onSkip={onSkip}
            skipping={skipping}
          />
        ) : (
          <ModelStep
            profileId={profileId!}
            onDone={onDone}
          />
        )}

        <div className="login-footer">
          <span className="status">tls 1.3 · zero-data-retention</span>
        </div>
      </div>
    </div>
  );
}

function CredentialStep({
  kind, setKind, secret, setSecret, baseUrl, setBaseUrl, showAdvanced, setShowAdvanced, submitting, error, onSubmit, onOauthConnected, onErrorClear, onSkip, skipping,
}: {
  kind: CredentialKind;
  setKind: (k: CredentialKind) => void;
  secret: string;
  setSecret: (s: string) => void;
  baseUrl: string;
  setBaseUrl: (s: string) => void;
  showAdvanced: boolean;
  setShowAdvanced: (v: boolean) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
  onOauthConnected: () => void;
  onErrorClear: () => void;
  onSkip: () => void;
  skipping: boolean;
}) {
  const entitlements = useEntitlements();
  // ChatGPT-subscription device login (shared with Settings → Keys). The poll
  // route creates the credential + default profile server-side, so success
  // just advances the wizard.
  const codex = useChatGptSignIn(onOauthConnected);
  // Claude subscription: browser sign-in is the primary path; the legacy
  // paste-a-setup-token field stays available behind a toggle.
  const claude = useClaudeSignIn(onOauthConnected);
  const [usePasteToken, setUsePasteToken] = useState(false);
  const claudeSelected = kind === "anthropic_oauth" && !usePasteToken;
  const oauthSelected = !!CRED_META[kind].oauthLogin;
  const signingIn = codex.status === "starting" || codex.status === "waiting";
  const claudeBusy = claude.status === "starting" || claude.status === "completing";
  // Switching provider mid-sign-in abandons the flows — stop poll/paste.
  // Keyed on `kind` (not the derived booleans) so any provider change
  // cancels whichever flow was running.
  useEffect(() => {
    if (!CRED_META[kind].oauthLogin) codex.cancel();
    if (kind !== "anthropic_oauth") { claude.cancel(); setUsePasteToken(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);
  return (
    <div className="login-card login-card--wide">
      <span className="vz-eyebrow">Step 1 of 2 — credential</span>
      <h1>Pick a <em>provider.</em></h1>
      <p className="lede">
        We'll create a default agent so your workspace is ready to chat. You can add more credentials, agents, and integrations later in Settings.
      </p>

      <form className="login-form" onSubmit={onSubmit}>
        <fieldset className="cred-options" aria-label="Provider">
          {(Object.keys(CRED_META) as CredentialKind[])
            // Entitlement-gated providers only show for entitled users (OSS
            // grants subscription_oauth by default). Of the oauthLogin
            // providers, the ChatGPT device login is wired into this wizard
            // via the shared ChatGptSignIn flow; any future ones stay hidden
            // until they are.
            .filter((k) => {
              const m = CRED_META[k];
              if (m.entitlement && !entitlements.includes(m.entitlement)) return false;
              return !m.oauthLogin || m.kind === "openai_oauth";
            })
            .map((k) => (
            <CredOption
              key={k}
              value={k}
              current={kind}
              onChange={setKind}
              label={CRED_META[k].label}
              hint={CRED_META[k].hint}
            />
          ))}
        </fieldset>

        {CRED_META[kind].warning && (
          <div
            role="alert"
            style={{
              display: "flex", gap: 8, alignItems: "flex-start",
              padding: "10px 12px", borderRadius: "var(--vz-radius-md)",
              background: "color-mix(in srgb, var(--vz-warn) 12%, transparent)",
              border: "1px solid color-mix(in srgb, var(--vz-warn) 40%, transparent)",
              fontSize: 12.5, lineHeight: 1.45, color: "var(--vz-ink)", margin: "0.35rem 0",
            }}
          >
            <AlertTriangle size={15} style={{ color: "var(--vz-warn)", flexShrink: 0, marginTop: 1 }} />
            <span>{CRED_META[kind].warning}</span>
          </div>
        )}

        {/* OAuth providers replace the paste-a-token field with the shared
            device-login flow (button below + inline status panel here). */}
        {!oauthSelected && !claudeSelected && <label className="vz-field">
          <span className="vz-field__label">{CRED_META[kind].fieldLabel}</span>
          <input
            type="password"
            className="vz-input"
            placeholder={CRED_META[kind].placeholder}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            required
            autoComplete="off"
            autoFocus
          />
        </label>}

        {oauthSelected && codex.status !== "idle" && <ChatGptSignInPanel state={codex} />}

        {claudeSelected && claude.status !== "idle" && <ClaudeSignInPanel state={claude} />}

        {kind === "anthropic_oauth" && (
          <button
            type="button"
            onClick={() => { setUsePasteToken(!usePasteToken); claude.cancel(); }}
            style={{ alignSelf: "flex-start", background: "none", border: 0, color: "var(--vz-muted)", fontSize: "0.8rem", cursor: "pointer", padding: 0, fontFamily: "inherit" }}
          >
            {usePasteToken ? "← Sign in with your browser instead" : "Paste a setup-token instead (claude setup-token)"}
          </button>
        )}

        {kind === "openai" && (showAdvanced ? (
          <label className="vz-field">
            <span className="vz-field__label">Base URL</span>
            <input
              type="text"
              className="vz-input"
              placeholder="https://api.openai.com"
              value={baseUrl}
              onChange={(e) => setBaseUrl(e.target.value)}
              autoComplete="off"
            />
            <span className="vz-field__hint" style={{ fontSize: "0.78rem", opacity: 0.6 }}>
              For OpenAI-compatible endpoints (OpenRouter, Azure, vLLM, LM Studio). Leave blank for OpenAI.
            </span>
          </label>
        ) : (
          <button
            type="button"
            onClick={() => setShowAdvanced(true)}
            style={{ alignSelf: "flex-start", background: "none", border: 0, color: "var(--vz-muted)", fontSize: "0.8rem", cursor: "pointer", padding: 0, fontFamily: "inherit" }}
          >
            + Advanced — use a custom OpenAI-compatible endpoint
          </button>
        ))}

        {error && <p className="login-error" role="alert">{error}</p>}

        {claudeSelected ? (
          <button
            type="button"
            onClick={() => { onErrorClear(); claude.start(); }}
            className="vz-btn vz-btn--primary vz-btn--mono login-submit"
            disabled={claudeBusy || claude.status === "waiting" || skipping}
          >
            {claude.status === "waiting" || claudeBusy ? "Waiting for the pasted code…" : "Sign in with Claude →"}
          </button>
        ) : oauthSelected ? (
          <button
            type="button"
            onClick={() => { onErrorClear(); codex.start(); }}
            className="vz-btn vz-btn--primary vz-btn--mono login-submit"
            disabled={signingIn || skipping}
          >
            {signingIn ? "Waiting for ChatGPT approval…" : "Sign in with ChatGPT →"}
          </button>
        ) : (
          <button
            type="submit"
            className="vz-btn vz-btn--primary vz-btn--mono login-submit"
            disabled={submitting || skipping}
          >
            {submitting ? "Validating credential…" : "Continue →"}
          </button>
        )}

        {/* Escape hatch for a cautious user: create a keyless default agent and
            drop into the app. The workspace's no-key state guides them to add a
            key when ready, so they can look around first. */}
        <button
          type="button"
          onClick={onSkip}
          disabled={submitting || skipping}
          style={{ alignSelf: "center", background: "none", border: 0, color: "var(--vz-muted)", fontSize: "0.8rem", cursor: "pointer", padding: "2px 0", marginTop: 2, fontFamily: "inherit", textDecoration: "underline" }}
        >
          {skipping ? "Setting up…" : "Skip for now — explore without a key"}
        </button>

        <p className="login-tos">
          Local Ollama (no key) is on the roadmap. You can also configure additional providers later in <a href="/settings">Settings</a>.
        </p>
      </form>
    </div>
  );
}

function ModelStep({ profileId, onDone }: { profileId: string; onDone: () => void }) {
  const [models, setModels] = useState<ProfileModel[] | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    fetch(`/v1/profiles/${encodeURIComponent(profileId)}/models`, { credentials: "include" })
      .then(async (r) => {
        if (!r.ok) {
          const body = (await r.json().catch(() => ({}))) as { error?: string };
          throw new Error(body.error ?? `HTTP ${r.status}`);
        }
        return r.json() as Promise<{ models: ProfileModel[] }>;
      })
      .then((data) => {
        setModels(data.models);
        // Sensible default: prefer Sonnet (most users), else first.
        const sonnet = data.models.find((m) => /sonnet/i.test(m.id));
        setChosen((sonnet ?? data.models[0])?.id ?? "");
      })
      .catch((err) => {
        const raw = err instanceof Error ? err.message : "Failed to load models";
        // Translate the cryptic fetch/Headers error that bleeds through
        // when a stored credential has a non-ASCII char (smart quote,
        // em-dash, zero-width space from copy-paste). After this commit
        // /v1/anthropic-keys rejects such keys at create time, but old
        // keys stored before may still trip it.
        const friendly = /ByteString|character at index/.test(raw)
          ? "Your stored credential contains a non-ASCII character (likely a smart quote or hidden character from copy-paste). Go to Settings → API Keys, delete it, and re-paste from the source."
          : raw;
        setError(friendly);
      });
  }, [profileId]);

  async function onModelSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    if (!chosen) {
      setError("Pick a model to continue.");
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(`/v1/profiles/${encodeURIComponent(profileId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ model: chosen }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to set model");
      setSubmitting(false);
    }
  }

  return (
    <div className="login-card login-card--wide">
      <span className="vz-eyebrow">Step 2 of 2 — default model</span>
      <h1>Pick a <em>model.</em></h1>
      <p className="lede">
        This is the model your default agent will use. You can switch per-workspace or per-task later.
      </p>

      <form className="login-form" onSubmit={onModelSubmit}>
        {models === null && !error && <p className="lede" style={{ opacity: 0.7 }}>Loading models from your provider…</p>}

        {models && models.length === 0 && (
          <p className="login-error" role="alert">
            No models available for this credential. Double-check the key and retry from <a href="/settings">Settings</a>.
          </p>
        )}

        {models && models.length > 0 && (() => {
          // Filter against both display name and raw id so users can
          // search by either. Show the search input only when the
          // catalog is large enough to actually need it (Ollama Cloud
          // catalogs can run to dozens; Anthropic's is short enough
          // that the input is just chrome).
          const q = query.trim().toLowerCase();
          const filtered = q
            ? models.filter((m) =>
                (m.display_name ?? "").toLowerCase().includes(q) ||
                m.id.toLowerCase().includes(q),
              )
            : models;
          return (
          <>
            {models.length >= 6 && (
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.currentTarget.value)}
                placeholder={`Filter ${models.length} models…`}
                aria-label="Filter models"
                style={{
                  width: "100%",
                  padding: "0.55rem 0.75rem",
                  fontSize: "0.85rem",
                  fontFamily: "var(--vz-font-mono)",
                  background: "var(--vz-mute)",
                  color: "var(--vz-ink)",
                  border: "1px solid var(--vz-border)",
                  borderRadius: 8,
                  outline: "none",
                  marginBottom: "0.1rem",
                }}
              />
            )}
            {filtered.length === 0 ? (
              <p className="lede" style={{ opacity: 0.6, fontSize: "0.85rem", margin: 0 }}>
                No models match &ldquo;{query}&rdquo;.
              </p>
            ) : (
          <fieldset
            style={{
              border: "none",
              padding: 0,
              margin: 0,
              display: "flex",
              flexDirection: "column",
              gap: "0.55rem",
              // Cap visible models at ~5 rows; Ollama Cloud accounts can
              // surface dozens. Inherits the global vz scrollbar styling
              // (brand/primitives.css) — thin, --vz-border-strong thumb.
              // Negative right margin + padding-right keep the thumb
              // flush with the card edge instead of clipped inside the
              // radio list's content rhythm.
              maxHeight: "calc(5 * 4.2rem)",
              overflowY: "auto",
              paddingRight: "0.5rem",
              marginRight: "-0.5rem",
            }}
          >
            {filtered.map((m) => (
              <label
                key={m.id}
                style={{
                  display: "flex",
                  gap: "0.7rem",
                  alignItems: "flex-start",
                  padding: "0.65rem 0.85rem",
                  border: `1px solid ${chosen === m.id ? "var(--vz-sodium)" : "var(--vz-border)"}`,
                  borderRadius: 8,
                  cursor: "pointer",
                  background: chosen === m.id ? "rgba(0, 191, 165, 0.06)" : "transparent",
                  transition: "border-color .15s, background .15s",
                }}
              >
                <input
                  type="radio"
                  name="model"
                  value={m.id}
                  checked={chosen === m.id}
                  onChange={() => setChosen(m.id)}
                  style={{ marginTop: "0.2rem" }}
                />
                <span style={{ display: "flex", flexDirection: "column", gap: "0.15rem", flex: 1 }}>
                  <span style={{ fontWeight: 500 }}>{m.display_name ?? m.id}</span>
                  <span style={{ fontSize: "0.78rem", opacity: 0.6, fontFamily: "var(--vz-font-mono)" }}>{m.id}</span>
                </span>
              </label>
            ))}
          </fieldset>
            )}
          </>
          );
        })()}

        {error && <p className="login-error" role="alert">{error}</p>}

        <button
          type="submit"
          className="vz-btn vz-btn--primary vz-btn--mono login-submit"
          disabled={submitting || models === null || models.length === 0}
        >
          {submitting ? "Saving…" : "Finish setup →"}
        </button>

        <p className="login-tos">
          Your default agent is ready to chat as soon as you pick a model.
        </p>
      </form>
    </div>
  );
}

function CredOption({
  value, current, onChange, label, hint,
}: {
  value: CredentialKind;
  current: CredentialKind;
  onChange: (v: CredentialKind) => void;
  label: string;
  hint: string;
}) {
  const selected = current === value;
  return (
    <label
      style={{
        display: "flex",
        gap: "0.7rem",
        alignItems: "flex-start",
        padding: "0.75rem 0.9rem",
        border: `1px solid ${selected ? "var(--vz-sodium)" : "var(--vz-border)"}`,
        borderRadius: 8,
        cursor: "pointer",
        background: selected ? "rgba(0, 191, 165, 0.06)" : "transparent",
        transition: "border-color .15s, background .15s",
      }}
    >
      <input
        type="radio"
        name="credential-kind"
        value={value}
        checked={selected}
        onChange={() => onChange(value)}
        style={{ marginTop: "0.2rem" }}
      />
      <span style={{ display: "flex", flexDirection: "column", gap: "0.15rem", flex: 1 }}>
        <span style={{ fontWeight: 500 }}>{label}</span>
        <span style={{ fontSize: "0.85rem", opacity: 0.75 }}>{hint}</span>
      </span>
    </label>
  );
}
