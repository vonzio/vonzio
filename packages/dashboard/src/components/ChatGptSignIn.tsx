import { useEffect, useRef, useState } from "react";
import { CheckCircle } from "lucide-react";
import { startCodexLogin, pollCodexLogin } from "../api/client.js";

/**
 * ChatGPT-subscription (Codex) OAuth device login — the SHARED state machine
 * and inline panel, extracted from Settings → Keys so the onboarding wizard
 * (and the first-key modal, eventually) can offer the same sign-in.
 *
 * The hook owns the whole flow: start → device code → open verify tab → poll
 * until approved / timeout / cancel. The server's poll route creates the
 * credential AND attaches it to (or creates) the default profile, so callers
 * only need `onConnected` to refresh their own view of the world.
 *
 * Presentation is a separate, chrome-free `<ChatGptSignInPanel>` (inline
 * styles over CSS vars only) so it drops into the settings `Modal` and the
 * onboarding `login-card` alike.
 */

export type ChatGptSignInStatus = "idle" | "starting" | "waiting" | "created" | "error";

export interface ChatGptSignInState {
  status: ChatGptSignInStatus;
  info: { user_code: string; verify_url: string } | null;
  error: string;
  /** Kick off (or restart) the device-login flow. No-op while one is running. */
  start: () => void;
  /** Abort a running flow and reset to idle (also safe when nothing runs). */
  cancel: () => void;
}

export function useChatGptSignIn(onConnected?: () => void): ChatGptSignInState {
  const [status, setStatus] = useState<ChatGptSignInStatus>("idle");
  const [info, setInfo] = useState<{ user_code: string; verify_url: string } | null>(null);
  const [error, setError] = useState("");
  // Per-attempt generation token. Every start() claims a new generation and
  // every cancel/unmount bumps it, so a superseded attempt (sleeping in its
  // poll timeout) can never resume, touch state, or fire onConnected — a
  // shared boolean abort flag gets un-aborted by the next start().
  const genRef = useRef(0);
  // Guard setState-after-unmount: a poll loop can outlive the component.
  const mountedRef = useRef(true);
  // Always call the LATEST onConnected — the closure captured at start() time
  // goes stale if the parent re-renders during the (up to 15 min) poll.
  const onConnectedRef = useRef(onConnected);
  useEffect(() => { onConnectedRef.current = onConnected; });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      genRef.current++;
    };
  }, []);

  const start = async () => {
    if (status === "starting" || status === "waiting") return;
    const gen = ++genRef.current;
    const live = () => mountedRef.current && genRef.current === gen;
    setStatus("starting"); setError(""); setInfo(null);
    try {
      const s = await startCodexLogin();
      if (!live()) return;
      setInfo({ user_code: s.user_code, verify_url: s.verify_url });
      setStatus("waiting");
      window.open(s.verify_url, "_blank", "noopener");
      const intervalMs = Math.max(2000, (s.interval_sec || 5) * 1000);
      const deadline = Date.now() + 15 * 60 * 1000;
      // Poll until the user approves in their browser (or it times out / cancels).
      while (live() && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (!live()) return;
        const p = await pollCodexLogin({ device_auth_id: s.device_auth_id, user_code: s.user_code });
        if (!live()) return;
        if (p.status === "created") {
          setStatus("created");
          onConnectedRef.current?.();
          return;
        }
        // pending / slow_down → keep waiting
      }
      if (live()) {
        setStatus("error"); setError("Sign-in timed out. Try again.");
      }
    } catch (e) {
      if (!live()) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  };

  const cancel = () => {
    genRef.current++;
    if (mountedRef.current) { setStatus("idle"); setInfo(null); setError(""); }
  };

  return { status, info, error, start, cancel };
}

/** ChatGPT ships with device sign-in disabled, so the flow dead-ends for
 *  most first-timers unless we point at the toggle. Shown while waiting and
 *  on failure (a rejected code / timeout is usually this, not a typo). */
const DEVICE_AUTH_HINT = (
  <div style={{ fontSize: 12.5, color: "var(--vz-muted)", borderTop: "1px solid var(--vz-border)", paddingTop: 10 }}>
    If ChatGPT rejects the code, enable device sign-in first: <strong>Settings → Security and login → Enable device code authorization for Codex</strong>. ChatGPT keeps it off by default and only recommends it for headless or remote environments where the normal browser flow isn't available.
  </div>
);

/** Chrome-free rendering of the flow's current state — embed anywhere. */
export function ChatGptSignInPanel({ state }: { state: ChatGptSignInState }) {
  const { status, info, error } = state;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14, fontSize: 13.5, lineHeight: 1.5, color: "var(--vz-ink)" }}>
      {status === "starting" && <div style={{ color: "var(--vz-muted)" }}>Starting sign-in…</div>}
      {status === "waiting" && info && (
        <>
          <div>A ChatGPT tab should have opened. Enter this code there to connect your subscription:</div>
          <div style={{ textAlign: "center", fontFamily: "var(--vz-font-mono)", fontSize: 26, letterSpacing: 3, fontWeight: 600, padding: "12px 0", color: "var(--vz-sodium)" }}>
            {info.user_code}
          </div>
          <div style={{ fontSize: 12.5, color: "var(--vz-muted)" }}>
            Didn't open?{" "}
            <a href={info.verify_url} target="_blank" rel="noopener noreferrer" style={{ color: "var(--vz-sodium)" }}>{info.verify_url}</a>
          </div>
          <div style={{ fontSize: 12.5, color: "var(--vz-muted)" }}>Waiting for approval…</div>
          {DEVICE_AUTH_HINT}
        </>
      )}
      {status === "created" && (
        <div style={{ color: "var(--vz-ok, #2faa6a)", display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle size={16} /> Connected. Your ChatGPT subscription is ready to use.
        </div>
      )}
      {status === "error" && (
        <>
          <div style={{ color: "var(--vz-fail)" }} role="alert">{error}</div>
          {DEVICE_AUTH_HINT}
        </>
      )}
    </div>
  );
}
