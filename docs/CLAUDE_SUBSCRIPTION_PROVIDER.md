# Claude subscription provider (BYO Claude Code OAuth token)

Status: **Design — not yet implemented.** No code changes have been made.

## Goal

Let each Vonzio user run agents against **their own Claude Pro/Max
subscription** instead of (or in addition to) a metered Anthropic API key.
Conceptually this is "Claude Code running on a remote box, as that one user" —
the credential belongs to the user, is used only for that user's agents, and is
never pooled or shared across accounts.

## Decision: acquisition strategy = "B" (user mints, we hold)

We considered two ways to obtain the subscription credential:

- **A — host the OAuth dance:** Vonzio drives the PKCE flow and stores each
  user's *refresh token*, minting access tokens on demand.
- **B — user mints, we store:** the user runs `claude setup-token` locally and
  pastes the resulting long-lived (~1 year) OAuth token; Vonzio stores it
  encrypted and injects it, exactly like it does an API key today.

**We are building B.** Rationale:

- ~80% less to build: no PKCE, no code exchange, no refresh-locking.
- Smaller blast radius: we hold an **inference-scoped access token**, not a
  refresh token that can mint credentials for a year.
- It reuses the existing "paste a secret → encrypt → inject as env" pipeline
  almost verbatim. The only genuinely new behavior is the provider branch and
  bearer-auth at a few server-side fetch sites.

Both A and B converge on the **same inference path** (a `sk-ant-oat01-…` token
in `CLAUDE_CODE_OAUTH_TOKEN` inside the container), so A can be layered on later
as a second acquisition mode behind the same provider without reworking
anything downstream. Anthropic has signalled an official mechanism is coming;
when it lands it slots in here too.

## How users mint the token (the hint we show in-product)

The settings/onboarding UI for this provider replaces the key textarea's helper
text with these steps (and links to Anthropic's auth docs):

> **Connect your Claude subscription**
> 1. Install Claude Code locally if you haven't: `npm i -g @anthropic-ai/claude-code`
> 2. Run **`claude setup-token`** in a terminal and log in with the Claude
>    account that has your Pro/Max subscription.
> 3. Copy the token it prints (starts with `sk-ant-oat01-`).
> 4. Paste it below.
>
> The token is scoped to inference only and is valid for about a year. We store
> it encrypted and use it solely to run *your* agents. Re-run the command and
> re-paste when it expires. Requires an active Claude Pro or Max subscription.

`PROVIDER_CATALOG` entry text (see `packages/shared/src/types/profile.ts`):

```ts
{
  kind: "anthropic_oauth",            // new UI discriminator
  provider: "claude_subscription",    // new ProfileProvider value
  label: "Claude subscription (Pro/Max)",
  hint: "Run `claude setup-token` locally and paste the sk-ant-oat01- token. Uses your own subscription.",
  fieldLabel: "Claude OAuth token",
  placeholder: "sk-ant-oat01-…",
  defaultKeyName: "My Claude subscription",
  consoleUrl: "https://docs.claude.com/en/docs/claude-code/setup-token", // verify exact URL during impl
  keyPrefix: "sk-ant-oat01-",
  supportsBaseUrl: false,
}
```

## Data model

Reuse the existing `api_keys` row. **Store the OAuth token in
`encrypted_api_key`** (not `encrypted_auth_token`) so the entire
`getResolved → resolved_api_key → buildEnvFromProfile` pipeline works unchanged;
the value just happens to be an `oat01` token instead of an `api03` key.

- `provider = "claude_subscription"`.
- `encrypted_auth_token` stays reserved for the future Option-A refresh token.
- `base_url` unused (no override for this provider).

Add `"claude_subscription"` to `PROFILE_PROVIDERS` (the DB enum on `api_keys`
and `profiles` derives from this array, so the column accepts it automatically).

## Inference path (the easy, stable part)

The Claude Agent SDK in the agent container authenticates with a subscription
token when `CLAUDE_CODE_OAUTH_TOKEN` is set; it then talks to the real
`api.anthropic.com` with `Authorization: Bearer …` and the OAuth beta header.
We do **not** route this provider through the in-container `llm-gateway` (unlike
openai/ollama) — it speaks native Anthropic.

In `orchestrator.ts` `buildEnvFromProfile` (~line 1737), add a branch **before**
the generic `resolved_api_key` fallback:

```ts
} else if (profile.resolved_provider === "claude_subscription" && profile.resolved_api_key) {
  // Subscription OAuth token — the Agent SDK uses it as a bearer credential
  // against the native Anthropic API. Do NOT also set ANTHROPIC_API_KEY.
  env.CLAUDE_CODE_OAUTH_TOKEN = profile.resolved_api_key;
}
```

## Server-side seams (bearer instead of x-api-key)

Three places call Anthropic directly and assume an `x-api-key` API key. Each
needs a `claude_subscription` variant that sends:

```
Authorization: Bearer <oat token>
anthropic-version: 2023-06-01
anthropic-beta: oauth-2025-04-20      # exact beta value to confirm in spike
```

(omit `x-api-key` entirely when using bearer)

1. `services/key-validator.ts` — `validateAnthropicKey`. Branch on the new
   provider; hit a lightweight endpoint to confirm the token works.
2. `services/model-list-service.ts` — `listForApiKey` (the `else` Anthropic
   branch, ~line 139).
3. `orchestrator/judge-server.ts` — the server-side goal-completion judge.

A small shared helper (`anthropicAuthHeaders(provider, secret)`) returning the
right header set would keep these three in sync.

## Known-uncertain items (spike before/during impl)

1. **`/v1/models` with an oat token may 403** (inference-scoped). If so,
   `model-list-service` returns a **hardcoded** model list for this provider
   (sonnet/opus/haiku family) rather than fetching. Confirm with a one-off call.
2. **Exact beta header value** (`anthropic-beta: oauth-…`) — confirm against a
   live `setup-token` token.
3. **Validation endpoint** — if `/v1/models` rejects oat tokens, validate with a
   tiny `/v1/messages` ping (1 token) instead, or accept-on-prefix + lazy-verify.

## Cross-cutting concerns

- **Egress (#196):** the network-layer allowlist must include
  `api.anthropic.com` for this provider. No `claude.ai`/`console.anthropic.com`
  needed (token is minted locally by the user, not exchanged by us).
- **Subscription rate limits ≠ API limits.** Pro/Max has rolling session/usage
  caps and the platform fans out parallel agents. Map Anthropic 429s on this
  provider to a clear "You've hit your Claude subscription limit — try again
  later" rather than a raw error, and avoid auto-retry storms.
- **Expiry UX:** when a request fails with 401 on this provider, surface
  "Your Claude subscription token expired — re-run `claude setup-token` and
  update it in Settings" and flag the key as needing attention.
- **Security:** token encrypted at rest with the existing `ENCRYPTION_KEY`;
  redacted in API responses like other secrets; never logged.

## File-by-file change checklist (for the eventual implementation PR)

- [ ] `packages/shared/src/types/profile.ts` — add `claude_subscription` to
      `PROFILE_PROVIDERS`; add `anthropic_oauth` to `ProviderInfo.kind`; add the
      `PROVIDER_CATALOG` entry above.
- [ ] `packages/core-server/src/orchestrator/orchestrator.ts` — new env branch
      setting `CLAUDE_CODE_OAUTH_TOKEN`.
- [ ] `packages/core-server/src/services/key-validator.ts` — bearer variant.
- [ ] `packages/core-server/src/services/model-list-service.ts` — bearer
      variant + hardcoded-model fallback if needed.
- [ ] `packages/core-server/src/orchestrator/judge-server.ts` — bearer variant.
- [ ] `packages/core-server/src/orchestrator/egress.*` — allow `api.anthropic.com`.
- [ ] `packages/dashboard/src/pages/settings/sections/AnthropicKey.tsx` — render
      the mint-token hint + paste field for the new provider.
- [ ] `packages/dashboard/src/pages/Onboarding.tsx` /
      `components/onboarding/AddFirstApiKey.tsx` — provider appears via catalog;
      verify hint copy renders.
- [ ] Error mapping for 401 (expired) / 429 (subscription cap) on this provider.
- [ ] Tests: provider resolution, env injection, validator, model-list fallback.

## Out of scope (future)

- Option A hosted OAuth/PKCE flow with refresh tokens (one-click connect).
- Switching to Anthropic's official subscription-auth mechanism once released —
  expected to be a drop-in at the acquisition layer only.
