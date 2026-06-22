import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { approveDeviceCode, ApiError } from "../api/client.js";
import { Button, Field, Input } from "../brand/components.js";
import { ThemeToggle } from "../components/ThemeToggle.js";
import "./login.css";

/**
 * Device-authorization verification page (RFC 8628). The CLI prints a code and
 * a link here; the logged-in user confirms it to approve the login. Rendered
 * headless (bare layout, no app shell) like the login/onboarding pages — but
 * still session-gated, so an unauthenticated visitor is routed to login first
 * (with ?returnTo back here). `?user_code=` pre-fills from the CLI link.
 */
export function Device() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [state, setState] = useState<"idle" | "submitting" | "approved" | "error">("idle");
  const [message, setMessage] = useState("");

  // After approval, auto-continue to the dashboard so the page isn't a dead end
  // (the CLI keeps working regardless). A manual link is offered as well.
  useEffect(() => {
    if (state !== "approved") return;
    const t = setTimeout(() => { window.location.href = "/"; }, 5000);
    return () => clearTimeout(t);
  }, [state]);

  const approve = async () => {
    if (!code.trim()) return;
    setState("submitting");
    setMessage("");
    try {
      await approveDeviceCode(code.trim());
      setState("approved");
    } catch (e) {
      setState("error");
      setMessage(e instanceof ApiError ? e.message : "Approval failed — try again.");
    }
  };

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

        <div className="login-card">
          <span className="vz-eyebrow">Connect a device</span>
          {state === "approved" ? (
            <>
              <h1>Device <em>approved.</em></h1>
              <p className="lede">
                Head back to your terminal — the CLI will finish signing in. You can manage or
                revoke this device anytime under <strong>Settings → Connected devices</strong>.
              </p>
              <p className="lede" style={{ marginTop: 4 }}>
                <a href="/" style={{ color: "var(--vz-sodium)", fontWeight: 600 }}>Continue to your dashboard →</a>
                <span style={{ color: "var(--vz-muted)" }}> &nbsp;(redirecting in a few seconds…)</span>
              </p>
            </>
          ) : (
            <>
              <h1>Authorize <em>this device.</em></h1>
              <p className="lede">
                Enter the code shown in your terminal. Only approve a code you started yourself.
              </p>
              <div style={{ display: "flex", flexDirection: "column", gap: 14, marginTop: 8 }}>
                <Field label="Device code">
                  <Input
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    placeholder="XXXX-XXXX"
                    autoFocus
                    onKeyDown={(e) => { if (e.key === "Enter") approve(); }}
                    style={{ fontFamily: "var(--vz-font-mono)", letterSpacing: "0.1em", textTransform: "uppercase" }}
                  />
                </Field>
                {state === "error" && (
                  <div style={{ fontSize: 12.5, color: "var(--vz-fail)" }}>{message}</div>
                )}
                <Button onClick={approve} disabled={state === "submitting" || !code.trim()}>
                  {state === "submitting" ? "Approving…" : "Approve device"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
