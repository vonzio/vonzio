import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { approveDeviceCode, ApiError } from "../api/client.js";
import { PageHeader, PageBody, Card, Button, Field, Input } from "../brand/components.js";

/**
 * Device-authorization verification page (RFC 8628). The CLI prints a code and
 * a link here; the logged-in user confirms it to approve the login. Lives at
 * /device (shell layout → requires a session; unauthenticated users are routed
 * to login first). `?user_code=` pre-fills from `verification_uri_complete`.
 */
export function Device() {
  const [params] = useSearchParams();
  const [code, setCode] = useState(params.get("user_code") ?? "");
  const [state, setState] = useState<"idle" | "submitting" | "approved" | "error">("idle");
  const [message, setMessage] = useState("");

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
    <>
      <PageHeader eyebrow="Devices" title="Connect a device" lede="Authorize the vonzio CLI (or another device) to act as you." />
      <PageBody>
        <div style={{ maxWidth: 440 }}>
          <Card>
            {state === "approved" ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                <div style={{ fontSize: 14, fontWeight: 600, color: "var(--vz-ok)" }}>Device approved ✓</div>
                <p style={{ margin: 0, fontSize: 13, color: "var(--vz-muted)", lineHeight: 1.5 }}>
                  Head back to your terminal — the CLI will finish signing in. You can manage or
                  revoke this device anytime under <strong>Settings → API tokens</strong>.
                </p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
                <p style={{ margin: 0, fontSize: 13, color: "var(--vz-muted)", lineHeight: 1.5 }}>
                  Enter the code shown in your terminal to authorize this device. Only approve a
                  code you started yourself.
                </p>
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
                <div>
                  <Button onClick={approve} disabled={state === "submitting" || !code.trim()}>
                    {state === "submitting" ? "Approving…" : "Approve device"}
                  </Button>
                </div>
              </div>
            )}
          </Card>
        </div>
      </PageBody>
    </>
  );
}
