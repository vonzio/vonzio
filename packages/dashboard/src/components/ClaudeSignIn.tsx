import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "lucide-react";
import { startClaudeLogin, completeClaudeLogin } from "../api/client.js";

/**
 * Claude Pro/Max subscription OAuth sign-in — shared state machine + inline
 * panel (the sibling of ChatGptSignIn, used by Settings → Keys and the
 * onboarding wizard).
 *
 * Anthropic has no third-party device grant, so instead of polling: start()
 * opens the consent page in a new tab; after approval the page DISPLAYS a
 * `code#state` string; the user pastes it into the panel and submitCode()
 * exchanges it server-side (credential + default agent are created by the
 * complete route). Per-attempt generation tokens make cancel/restart races
 * impossible, same as the ChatGPT hook.
 */

export type ClaudeSignInStatus = "idle" | "starting" | "waiting" | "completing" | "created" | "error";

export interface ClaudeSignInState {
  status: ClaudeSignInStatus;
  authorizeUrl: string | null;
  error: string;
  start: () => void;
  submitCode: (code: string) => void;
  cancel: () => void;
}

export function useClaudeSignIn(onConnected?: () => void): ClaudeSignInState {
  const [status, setStatus] = useState<ClaudeSignInStatus>("idle");
  const [authorizeUrl, setAuthorizeUrl] = useState<string | null>(null);
  const [error, setError] = useState("");
  const authIdRef = useRef<string | null>(null);
  const genRef = useRef(0);
  const mountedRef = useRef(true);
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; });
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; genRef.current++; };
  }, []);

  const start = async () => {
    if (status === "starting" || status === "completing") return;
    const gen = ++genRef.current;
    const live = () => mountedRef.current && genRef.current === gen;
    setStatus("starting"); setError(""); setAuthorizeUrl(null);
    try {
      const s = await startClaudeLogin();
      if (!live()) return;
      authIdRef.current = s.auth_id;
      setAuthorizeUrl(s.authorize_url);
      setStatus("waiting");
      window.open(s.authorize_url, "_blank", "noopener");
    } catch (e) {
      if (!live()) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Sign-in failed to start.");
    }
  };

  const submitCode = async (code: string) => {
    const authId = authIdRef.current;
    if (!authId || !code.trim() || status === "completing") return;
    const gen = ++genRef.current;
    const live = () => mountedRef.current && genRef.current === gen;
    setStatus("completing"); setError("");
    try {
      await completeClaudeLogin({ auth_id: authId, code: code.trim() });
      if (!live()) return;
      setStatus("created");
      onConnectedRef.current?.();
    } catch (e) {
      if (!live()) return;
      // Back to waiting so the user can re-paste (typos are the common case).
      setStatus("waiting");
      setError(e instanceof Error ? e.message : "Code exchange failed.");
    }
  };

  const cancel = () => {
    genRef.current++;
    authIdRef.current = null;
    if (mountedRef.current) { setStatus("idle"); setAuthorizeUrl(null); setError(""); }
  };

  return { status, authorizeUrl, error, start, submitCode, cancel };
}

/** Chrome-free rendering — embeds in the settings Modal and the onboarding
 *  login-card alike. Owns only the local code-input state. */
export function ClaudeSignInPanel({ state }: { state: ClaudeSignInState }) {
  const { status, authorizeUrl, error } = state;
  const [code, setCode] = useState("");
  // A cancel/restart mints a fresh auth token — stale pasted input from the
  // previous attempt would just fail its state check. Clear it.
  useEffect(() => {
    if (status === "idle" || status === "starting") setCode("");
  }, [status]);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13.5, lineHeight: 1.5, color: "var(--vz-ink)" }}>
      {status === "starting" && <div style={{ color: "var(--vz-muted)" }}>Starting sign-in…</div>}
      {(status === "waiting" || status === "completing") && (
        <>
          <div>A Claude tab should have opened. Approve access there, then paste the code it shows you:</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value)}
              placeholder="Paste the code (looks like abc123…#def456…)"
              autoComplete="off"
              spellCheck={false}
              disabled={status === "completing"}
              onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); state.submitCode(code); } }}
              style={{
                flex: 1, padding: "8px 10px", borderRadius: 8, fontFamily: "var(--vz-font-mono)",
                fontSize: 12.5, border: "1px solid var(--vz-border)", background: "transparent", color: "var(--vz-ink)",
              }}
            />
            <button
              type="button"
              onClick={() => state.submitCode(code)}
              disabled={status === "completing" || !code.trim()}
              style={{
                padding: "8px 14px", borderRadius: 8, border: "1px solid var(--vz-sodium)",
                background: "var(--vz-sodium)", color: "#fff", cursor: "pointer", fontSize: 12.5,
                opacity: status === "completing" || !code.trim() ? 0.6 : 1,
              }}
            >
              {status === "completing" ? "Connecting…" : "Connect"}
            </button>
          </div>
          {authorizeUrl && (
            <div style={{ fontSize: 12.5, color: "var(--vz-muted)" }}>
              Didn't open?{" "}
              <a href={authorizeUrl} target="_blank" rel="noopener noreferrer" style={{ color: "var(--vz-sodium)" }}>Open the sign-in page</a>
            </div>
          )}
        </>
      )}
      {status === "created" && (
        <div style={{ color: "var(--vz-ok, #2faa6a)", display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle size={16} /> Connected. Your Claude subscription is ready to use.
        </div>
      )}
      {error && status !== "created" && <div style={{ color: "var(--vz-fail)" }} role="alert">{error}</div>}
    </div>
  );
}
