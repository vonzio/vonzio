import { useState, useEffect, type FormEvent } from "react";
import "./login.css";

/**
 * OSS post-signup onboarding wizard. Renders when a signed-in user has
 * zero profiles. Two steps:
 *   1. Pick credential — Anthropic API key, Anthropic subscription
 *      token, or Ollama Cloud API key. All three submit to
 *      /v1/anthropic-keys with the right `provider` value; the endpoint
 *      auto-creates a default profile bound to that key with matching
 *      provider (routes/user-resources.ts:188-192).
 *   2. Pick default model — fetches /v1/profiles/:id/models so the user
 *      sees what the key actually has access to (Anthropic returns
 *      claude-*, Ollama returns the user's available Ollama Cloud
 *      models), then PATCHes the profile with the chosen model.
 *
 * Reuses the same .sodium-shell + login.css chrome as Login/Setup so the
 * post-signup journey looks like one cohesive flow.
 */

type CredentialKind = "anthropic_key" | "anthropic_subscription" | "ollama";

const CRED_META: Record<CredentialKind, {
  label: string;
  hint: string;
  fieldLabel: string;
  placeholder: string;
  keyName: string;
  provider: "api_key" | "subscription_token" | "ollama";
  bodyKey: "api_key" | "auth_token";
}> = {
  anthropic_key: {
    label: "Anthropic API key",
    hint: "From console.anthropic.com — starts with sk-ant-",
    fieldLabel: "API key",
    placeholder: "sk-ant-...",
    keyName: "Anthropic API key",
    provider: "api_key",
    bodyKey: "api_key",
  },
  anthropic_subscription: {
    label: "Anthropic subscription token",
    hint: "From claude.ai cookies — uses your Claude.ai plan",
    fieldLabel: "Subscription token",
    placeholder: "Paste subscription token",
    keyName: "Anthropic subscription",
    provider: "subscription_token",
    bodyKey: "auth_token",
  },
  ollama: {
    label: "Ollama Cloud API key",
    hint: "From ollama.com — paid tier required for now (local Ollama coming later)",
    fieldLabel: "Ollama API key",
    placeholder: "Paste Ollama Cloud key",
    keyName: "Ollama Cloud",
    provider: "ollama",
    bodyKey: "api_key",
  },
};

interface ProfileModel {
  id: string;
  display_name: string | null;
  provider: "anthropic" | "ollama";
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
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

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
          name: meta.keyName,
          provider: meta.provider,
          [meta.bodyKey]: trimmed,
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `HTTP ${res.status}`);
      }
      // The endpoint auto-created a default profile when the user had zero.
      // Fetch it so step 2 can ask for /v1/profiles/:id/models with the
      // right id (the POST response is the key, not the profile).
      const profilesRes = await fetch("/v1/profiles", { credentials: "include" });
      const profiles = (await profilesRes.json()) as Array<{ id: string; user_id: string | null }>;
      const own = profiles.find((p) => p.user_id);
      if (!own) throw new Error("Default profile was not created — please retry.");
      setProfileId(own.id);
      setStep("model");
      setSubmitting(false);
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

        <p className="login-pullquote">One credential, one default agent. You're 30 seconds away.</p>

        {step === "credential" ? (
          <CredentialStep
            kind={kind}
            setKind={setKind}
            secret={secret}
            setSecret={setSecret}
            submitting={submitting}
            error={error}
            onSubmit={onCredentialSubmit}
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
  kind, setKind, secret, setSecret, submitting, error, onSubmit,
}: {
  kind: CredentialKind;
  setKind: (k: CredentialKind) => void;
  secret: string;
  setSecret: (s: string) => void;
  submitting: boolean;
  error: string | null;
  onSubmit: (e: FormEvent<HTMLFormElement>) => void;
}) {
  return (
    <div className="login-card">
      <span className="vz-eyebrow">Step 1 of 2 — credential</span>
      <h1>Pick a <em>provider.</em></h1>
      <p className="lede">
        We'll create a default agent so your workspace is ready to chat. You can add more credentials, agents, and integrations later in Settings.
      </p>

      <form className="login-form" onSubmit={onSubmit}>
        <fieldset style={{ border: "none", padding: 0, margin: 0, display: "flex", flexDirection: "column", gap: "0.65rem" }}>
          {(Object.keys(CRED_META) as CredentialKind[]).map((k) => (
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

        <label className="vz-field">
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
        </label>

        {error && <p className="login-error" role="alert">{error}</p>}

        <button
          type="submit"
          className="vz-btn vz-btn--primary vz-btn--mono login-submit"
          disabled={submitting}
        >
          {submitting ? "Validating credential…" : "Continue →"}
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
    <div className="login-card">
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

        {models && models.length > 0 && (
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
            {models.map((m) => (
              <label
                key={m.id}
                style={{
                  display: "flex",
                  gap: "0.7rem",
                  alignItems: "flex-start",
                  padding: "0.65rem 0.85rem",
                  border: `1px solid ${chosen === m.id ? "var(--vz-sodium)" : "var(--vz-line, #2a3340)"}`,
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
                  <span style={{ fontSize: "0.78rem", opacity: 0.6, fontFamily: "var(--vz-mono, monospace)" }}>{m.id}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}

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
        border: `1px solid ${selected ? "var(--vz-sodium)" : "var(--vz-line, #2a3340)"}`,
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
