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
  const abortRef = useRef(false);
  // Guard setState-after-unmount: a poll loop can outlive the component.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      abortRef.current = true;
    };
  }, []);

  const start = async () => {
    if (status === "starting" || status === "waiting") return;
    setStatus("starting"); setError(""); setInfo(null);
    abortRef.current = false;
    try {
      const s = await startCodexLogin();
      if (abortRef.current) return;
      setInfo({ user_code: s.user_code, verify_url: s.verify_url });
      setStatus("waiting");
      window.open(s.verify_url, "_blank", "noopener");
      const intervalMs = Math.max(2000, (s.interval_sec || 5) * 1000);
      const deadline = Date.now() + 15 * 60 * 1000;
      // Poll until the user approves in their browser (or it times out / cancels).
      while (!abortRef.current && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (abortRef.current) return;
        const p = await pollCodexLogin({ device_auth_id: s.device_auth_id, user_code: s.user_code });
        if (p.status === "created") {
          if (!mountedRef.current) return;
          setStatus("created");
          onConnected?.();
          return;
        }
        // pending / slow_down → keep waiting
      }
      if (!abortRef.current && mountedRef.current) {
        setStatus("error"); setError("Sign-in timed out. Try again.");
      }
    } catch (e) {
      if (!mountedRef.current) return;
      setStatus("error");
      setError(e instanceof Error ? e.message : "Sign-in failed.");
    }
  };

  const cancel = () => {
    abortRef.current = true;
    if (mountedRef.current) { setStatus("idle"); setInfo(null); setError(""); }
  };

  return { status, info, error, start, cancel };
}

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
        </>
      )}
      {status === "created" && (
        <div style={{ color: "var(--vz-ok, #2faa6a)", display: "flex", alignItems: "center", gap: 8 }}>
          <CheckCircle size={16} /> Connected. Your ChatGPT subscription is ready to use.
        </div>
      )}
      {status === "error" && <div style={{ color: "var(--vz-fail)" }} role="alert">{error}</div>}
    </div>
  );
}
