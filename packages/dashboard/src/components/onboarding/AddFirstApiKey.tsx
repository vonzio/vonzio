import { useState } from "react";
import { Key, ExternalLink, AlertTriangle } from "lucide-react";
import { Button, Field, Input, Select } from "@/brand/components.js";
import { createUserAnthropicKey, fetchUserAnthropicKeys } from "@/api/client.js";
import type { OnboardingStepProps } from "@/registry/index.js";
import { PROVIDER_CATALOG, providerInfoByProvider, type ProfileProvider } from "@vonzio/shared";

/**
 * First-run onboarding step shown when the user has no API keys.
 * The user-create after-hook clones a profile but leaves api_key_id
 * null, so a brand-new user lands on Workspace with a profile that
 * can't actually run an agent. This modal closes that gap with a
 * single screen: pick a provider, paste a key, click Save, done — the
 * POST /v1/anthropic-keys endpoint also auto-creates a default
 * profile linked to the key for users who don't have one yet.
 *
 * The provider list + its labels/placeholders/console URLs come from the
 * shared PROVIDER_CATALOG (the single source of truth), so this stays in
 * lockstep with the onboarding wizard and the Settings → keys editor.
 */
export function AddFirstApiKey({ onNext, onSkip }: OnboardingStepProps) {
  const [provider, setProvider] = useState<ProfileProvider>(PROVIDER_CATALOG[0].provider);
  const meta = providerInfoByProvider(provider);
  const [name, setName] = useState(meta.defaultKeyName);
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  // Track whether the user has edited the label so switching providers can
  // keep their custom name but still update an untouched default.
  const [nameTouched, setNameTouched] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectProvider = (p: ProfileProvider) => {
    setProvider(p);
    setError(null);
    const next = providerInfoByProvider(p);
    if (!nameTouched) setName(next.defaultKeyName);
    if (!next.supportsBaseUrl) setBaseUrl("");
  };

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError(`Paste your ${meta.label} first.`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createUserAnthropicKey({
        name: name.trim() || meta.defaultKeyName,
        provider: meta.provider,
        api_key: apiKey.trim(),
        ...(meta.supportsBaseUrl && baseUrl.trim() ? { base_url: baseUrl.trim() } : {}),
      });
      // Tell open pages (e.g. the workspace) that a key/profile changed so they
      // refetch and drop the no-key gating without a full reload.
      window.dispatchEvent(new Event("vonzio:profiles:changed"));
      onNext();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save the key.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <div
          style={{
            width: 32, height: 32, borderRadius: 8,
            background: "var(--vz-sodium-08)", color: "var(--vz-sodium)",
            display: "flex", alignItems: "center", justifyContent: "center",
            flexShrink: 0,
          }}
        >
          <Key size={16} />
        </div>
        <div>
          <div style={{ fontSize: 16, fontWeight: 600, color: "var(--vz-ink)" }}>
            Welcome — let's add an API key
          </div>
          <div style={{ fontSize: 13, color: "var(--vz-muted)", marginTop: 2 }}>
            One key is all you need to start chatting. We'll also wire it to your default agent.
          </div>
        </div>
      </div>

      {/* Provider picker — a dropdown (scales to many providers) rendered
          from the shared catalog, mirroring Settings → Keys. */}
      <Field label="Provider">
        <Select
          value={provider}
          onChange={(v) => selectProvider(v as ProfileProvider)}
          options={PROVIDER_CATALOG.filter((p) => !p.oauthLogin).map((p) => ({ value: p.provider, label: p.label }))}
        />
      </Field>

      <Field label="Label" hint="A short name so you can recognize this key later.">
        <Input
          value={name}
          onChange={(e) => { setName(e.currentTarget.value); setNameTouched(true); }}
          placeholder={meta.defaultKeyName}
          autoFocus={false}
        />
      </Field>

      {meta.warning && (
        <div
          role="alert"
          style={{
            display: "flex", gap: 8, alignItems: "flex-start",
            padding: "10px 12px", borderRadius: "var(--vz-radius-md)",
            background: "color-mix(in srgb, var(--vz-warn) 12%, transparent)",
            border: "1px solid color-mix(in srgb, var(--vz-warn) 40%, transparent)",
            fontSize: 12.5, lineHeight: 1.45, color: "var(--vz-ink)",
          }}
        >
          <AlertTriangle size={15} style={{ color: "var(--vz-warn)", flexShrink: 0, marginTop: 1 }} />
          <span>{meta.warning}</span>
        </div>
      )}

      <Field
        label={meta.fieldLabel}
        hint={
          // For OAuth subscription tokens the *instruction* (run `claude
          // setup-token`) is the key part — lead with meta.hint and follow with
          // a docs link. For plain API keys keep the familiar "Get one at …".
          meta.kind === "anthropic_oauth" ? (
            <>
              {meta.hint}
              {meta.consoleUrl ? (
                <>
                  {" "}
                  <a
                    href={meta.consoleUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--vz-sodium)", display: "inline-flex", alignItems: "center", gap: 3 }}
                  >
                    Docs<ExternalLink size={11} />
                  </a>
                </>
              ) : null}
            </>
          ) : meta.consoleUrl ? (
            <>
              Get one at{" "}
              <a
                href={meta.consoleUrl}
                target="_blank"
                rel="noopener noreferrer"
                style={{ color: "var(--vz-sodium)", display: "inline-flex", alignItems: "center", gap: 3 }}
              >
                {meta.consoleUrl.replace(/^https?:\/\//, "")}
                <ExternalLink size={11} />
              </a>
              {meta.keyPrefix ? <>. Starts with <code>{meta.keyPrefix}</code>.</> : "."}
            </>
          ) : meta.hint
        }
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
          placeholder={meta.placeholder}
          autoComplete="off"
          autoFocus
        />
      </Field>

      {meta.supportsBaseUrl && (
        <Field
          label="Base URL"
          hint="Optional — for Azure / OpenRouter / vLLM / LM Studio and other OpenAI-compatible endpoints."
        >
          <Input
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.currentTarget.value)}
            placeholder="https://api.openai.com/v1"
            autoComplete="off"
          />
        </Field>
      )}

      {error && (
        <div style={{ fontSize: 12, color: "var(--vz-danger)" }}>{error}</div>
      )}

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, paddingTop: 4 }}>
        <Button variant="ghost" onClick={onSkip} disabled={saving}>
          Skip for now
        </Button>
        <Button onClick={handleSave} disabled={saving || !apiKey.trim()}>
          {saving ? "Saving…" : "Save and continue"}
        </Button>
      </div>
    </div>
  );
}

/** Predicate: returns true when the user has zero API keys. Memoizes
 *  the result for 30s so navigation between routes doesn't pound the
 *  endpoint. Failures bias toward "no keys" — better to occasionally
 *  show the modal to a user who has keys than to silently leave a
 *  brand-new user stuck behind an opaque error. */
let cached: { at: number; value: boolean } | null = null;
const TTL_MS = 30_000;
export async function hasNoApiKeysPredicate(): Promise<boolean> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.value;
  try {
    const keys = await fetchUserAnthropicKeys();
    const value = keys.length === 0;
    cached = { at: Date.now(), value };
    return value;
  } catch {
    return true;
  }
}
