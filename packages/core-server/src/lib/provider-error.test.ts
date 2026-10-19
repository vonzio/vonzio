import { describe, expect, it } from "vitest";
import { OPENCODE_FREE_TIER_MESSAGE, SWITCH_MODEL_HINT, humanizeProviderError, isAuthFailure, stripSdkErrorPrefix } from "./provider-error.js";

describe("humanizeProviderError", () => {
  it("rewords a Codex model rejection with a switch-model hint", () => {
    const raw = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"The \'claude-opus-4-8\' model is not supported when using Codex with a ChatGPT account."}}';
    expect(humanizeProviderError(raw)).toBe(
      `The 'claude-opus-4-8' model is not supported when using Codex with a ChatGPT account. ${SWITCH_MODEL_HINT}`,
    );
  });

  it("unwraps a raw upstream {detail} body and a nested HTTP body", () => {
    expect(humanizeProviderError('API Error: 400 {"detail":"The \'gpt-x\' model is not supported when using Codex with a ChatGPT account."}'))
      .toMatch(/^The 'gpt-x' model is not supported .*Pick a different model/);
    const nested = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"HTTP 400: {\\"error\\":{\\"message\\":\\"The model `foo` does not exist\\"}}"}}';
    expect(humanizeProviderError(nested)).toBe(`The model \`foo\` does not exist. ${SWITCH_MODEL_HINT}`);
  });

  it("does not double byok's own pick-another-model hint", () => {
    const raw = 'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"That model is not available for this ChatGPT account. Pick another model in Settings."}}';
    expect(humanizeProviderError(raw)).toBe(`That model is not available for this ChatGPT account. ${SWITCH_MODEL_HINT}`);
  });

  it("rewords the SDK's selected-model 404 copy", () => {
    const raw = "There's an issue with the selected model (claude-opus-4-8). It may not exist or you may not have access to it. Run /model to pick a different model.";
    expect(humanizeProviderError(raw)).toBe(
      `The model "claude-opus-4-8" isn't available on this provider or account. ${SWITCH_MODEL_HINT}`,
    );
  });

  it("maps an Anthropic not_found on the model", () => {
    expect(humanizeProviderError('API Error: 404 {"type":"error","error":{"type":"not_found_error","message":"model: claude-nope"}}'))
      .toBe(`model: claude-nope. ${SWITCH_MODEL_HINT}`);
  });

  it("turns other structured 4xx/5xx bodies into one readable line", () => {
    expect(humanizeProviderError('API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages: text content blocks must be non-empty"}}'))
      .toBe("The model provider rejected the request (HTTP 400): messages: text content blocks must be non-empty.");
    expect(humanizeProviderError('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}'))
      .toBe("The model provider rejected the request (HTTP 401): invalid x-api-key. Check the key, or sign in again, in Settings → Keys.");
    expect(humanizeProviderError('HTTP 502: {"error":"upstream down"}'))
      .toBe("The model provider failed (HTTP 502): upstream down.");
  });

  it("leaves non-errors and already-readable copy alone", () => {
    expect(humanizeProviderError("Here is the summary you asked for.")).toBeNull();
    expect(humanizeProviderError("API Error: Request was aborted.")).toBeNull();
    expect(humanizeProviderError("HTTP 500")).toBeNull();
    expect(humanizeProviderError("Agent failed: error_during_execution")).toBeNull();
    expect(humanizeProviderError("")).toBeNull();
    expect(humanizeProviderError(undefined)).toBeNull();
  });

  it("skips the bare HTTP form for model output when asked", () => {
    expect(humanizeProviderError('HTTP 400: {"error":"x"}', { httpForm: false })).toBeNull();
    expect(humanizeProviderError('API Error: 400 {"error":"x"}', { httpForm: false })).toMatch(/HTTP 400/);
  });
});

describe("rejected credentials", () => {
  const HINT = "Check the key, or sign in again, in Settings → Keys.";

  it("rewords the SDK's failed-to-authenticate copy with the key hint", () => {
    expect(humanizeProviderError("Failed to authenticate. API Error: 401 Unauthorized"))
      .toBe(`The model provider rejected the key (HTTP 401). ${HINT}`);
    expect(humanizeProviderError("Failed to authenticate. API Error: 401 Unauthorized", { httpForm: false }))
      .toBe(`The model provider rejected the key (HTTP 401). ${HINT}`);
    expect(humanizeProviderError("API Error: 403 Forbidden")).toBe(`The model provider rejected the key (HTTP 403). ${HINT}`);
    expect(humanizeProviderError("API Error: 401 key revoked")).toBe(`The model provider rejected the key (HTTP 401): key revoked. ${HINT}`);
    expect(humanizeProviderError("HTTP 401: Unauthorized")).toBe(`The model provider rejected the key (HTTP 401). ${HINT}`);
    expect(humanizeProviderError("Invalid API key · Please run /login")).toBe(`The model provider rejected the key. ${HINT}`);
  });

  it("strips the SDK's error-result prefix", () => {
    const raw = "Error: Claude Code returned an error result: Failed to authenticate. API Error: 401 Unauthorized";
    const out = humanizeProviderError(raw);
    expect(out).toBe(`The model provider rejected the key (HTTP 401). ${HINT}`);
    expect(stripSdkErrorPrefix("Claude Code returned an error result: something odd")).toBe("something odd");
    expect(stripSdkErrorPrefix("plain")).toBe("plain");
  });

  it("detects auth failures and nothing else", () => {
    expect(isAuthFailure("Claude Code returned an error result: Failed to authenticate. API Error: 401 Unauthorized")).toBe(true);
    expect(isAuthFailure("HTTP 403: nope")).toBe(true);
    expect(isAuthFailure("Invalid API key · Please run /login")).toBe(true);
    expect(isAuthFailure("API Error: 429 slow down")).toBe(false);
    expect(isAuthFailure("Invalid API key handling is covered in section 3 of the doc.")).toBe(false);
    expect(isAuthFailure(undefined)).toBe(false);
  });

  it("leaves model prose about keys alone", () => {
    expect(humanizeProviderError("Invalid API key handling is covered in section 3 of the doc.", { httpForm: false })).toBeNull();
  });
});

describe("OpenCode free tier", () => {
  const OLD = "OpenCode's free tier only works in OpenCode's own apps; a paid plan is needed.";

  it("says the model is free-tier, without the key hint or a doubled status", () => {
    for (const raw of [
      `API Error: 403 HTTP 403: ${OLD}`,
      `API Error: 403 ${JSON.stringify({ type: "error", error: { type: "permission_error", message: `HTTP 403: ${OLD}` } })}`,
      `Claude Code returned an error result: API Error: 403 HTTP 403: ${OPENCODE_FREE_TIER_MESSAGE}`,
      `HTTP 403: ${OLD}`,
    ]) {
      const out = humanizeProviderError(raw);
      expect(out).toBe(OPENCODE_FREE_TIER_MESSAGE);
      expect(out).not.toMatch(/Settings → Keys|HTTP 403/);
    }
  });

  it("does not repeat byok's HTTP status in other failures", () => {
    expect(humanizeProviderError("API Error: 403 HTTP 403: account suspended"))
      .toBe("The model provider rejected the key (HTTP 403): account suspended. Check the key, or sign in again, in Settings → Keys.");
    expect(humanizeProviderError("API Error: HTTP 401: token expired"))
      .toBe("The model provider rejected the key (HTTP 401): token expired. Check the key, or sign in again, in Settings → Keys.");
  });
});
