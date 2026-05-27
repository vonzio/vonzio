import { useState } from "react";
import { Key, ExternalLink } from "lucide-react";
import { Button, Field, Input } from "@/brand/components.js";
import { createUserAnthropicKey, fetchUserAnthropicKeys } from "@/api/client.js";
import type { OnboardingStepProps } from "@/registry/index.js";

/**
 * First-run onboarding step shown when the user has no API keys.
 * The user-create after-hook clones a profile but leaves api_key_id
 * null, so a brand-new user lands on Workspace with a profile that
 * can't actually run an agent. This modal closes that gap with a
 * single screen: paste an Anthropic key, click Save, done — the
 * POST /v1/anthropic-keys endpoint also auto-creates a default
 * profile linked to the key for users who don't have one yet.
 */
export function AddFirstApiKey({ onNext, onSkip }: OnboardingStepProps) {
  const [name, setName] = useState("My Anthropic key");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSave = async () => {
    if (!apiKey.trim()) {
      setError("Paste your Anthropic API key first.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await createUserAnthropicKey({
        name: name.trim() || "My Anthropic key",
        provider: "api_key",
        api_key: apiKey.trim(),
      });
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

      <Field label="Label" hint="A short name so you can recognize this key later.">
        <Input
          value={name}
          onChange={(e) => setName(e.currentTarget.value)}
          placeholder="My Anthropic key"
          autoFocus={false}
        />
      </Field>

      <Field
        label="Anthropic API key"
        hint={
          <>
            Get one at{" "}
            <a
              href="https://console.anthropic.com/settings/keys"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--vz-sodium)", display: "inline-flex", alignItems: "center", gap: 3 }}
            >
              console.anthropic.com/settings/keys
              <ExternalLink size={11} />
            </a>
            . Starts with <code>sk-ant-</code>.
          </>
        }
      >
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.currentTarget.value)}
          placeholder="sk-ant-…"
          autoComplete="off"
          autoFocus
        />
      </Field>

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
