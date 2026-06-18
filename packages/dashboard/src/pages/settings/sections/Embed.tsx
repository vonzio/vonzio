import { useState } from "react";
import { Copy, Check } from "lucide-react";
import { Card, Field, Input, Select, Banner, Button } from "../../../brand/components.js";
import { useApi } from "../../../hooks/useApi.js";
import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard.js";
import { fetchProfiles, type ProfileSummary } from "../../../api/client.js";

/**
 * Embed settings tab. Surfaces the chat widget snippet + direct chat link so
 * users can drop their agent onto any page. The "key" is a normal `rc_` API
 * token (created under Settings → API tokens, shown only once), so rather than
 * a picker we take a pasted token and render the snippet live.
 */
function CopyField({ value }: { value: string }) {
  const [copied, copy] = useCopyToClipboard();
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <code
        style={{
          flex: 1, minWidth: 0,
          fontFamily: "var(--vz-font-mono)", fontSize: 12.5,
          background: "var(--vz-mute)", border: "1px solid var(--vz-border)",
          borderRadius: "var(--vz-radius-sm)", padding: "8px 10px",
          overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
          color: "var(--vz-ink)",
        }}
        title={value}
      >
        {value}
      </code>
      <Button variant="ghost" size="sm" icon={copied ? <Check size={14} /> : <Copy size={14} />} onClick={() => copy(value)}>
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}

export function EmbedSection() {
  const origin = window.location.origin;
  const { data: profiles } = useApi<ProfileSummary[]>(() => fetchProfiles());
  const [token, setToken] = useState("");
  const [profile, setProfile] = useState("");

  const tok = token.trim() || "rc_YOUR_TOKEN";
  const profileAttr = profile ? ` data-profile="${profile}"` : "";
  const snippet = `<script src="${origin}/widget/vonzio.js" data-key="${tok}"${profileAttr}></script>`;
  const chatUrl = `${origin}/chat?key=${tok}${profile ? `&profile=${profile}` : ""}`;

  const profileOptions = [
    { value: "", label: "Default profile" },
    // value is the profile ID: session.start resolves profile_id by ID and the
    // token's allowedProfileIds scope check compares IDs — a slug would 403.
    ...(profiles ?? []).map((p) => ({ value: p.id, label: p.name })),
  ];

  return (
    <Card>
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        <Field
          label="API token"
          hint="Paste an rc_ token to fill the snippets below. Tokens are shown only once — at creation."
        >
          <Input value={token} onChange={(e) => setToken(e.target.value)} placeholder="rc_..." />
        </Field>

        <Field label="Profile" hint="The agent profile the embed will use.">
          <Select value={profile} onChange={setProfile} options={profileOptions} />
        </Field>

        <Field label="Embed widget" hint="Drop this into any page to mount the chat widget.">
          <CopyField value={snippet} />
        </Field>

        <Field label="Direct chat link" hint="A standalone chat page scoped to this token.">
          <CopyField value={chatUrl} />
        </Field>

        <Banner>
          Need a token? Create one under Settings → API tokens, then paste it here (it's shown only once).
        </Banner>
      </div>
    </Card>
  );
}
