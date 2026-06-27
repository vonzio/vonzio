import { useState, useEffect, useRef } from "react";
import { ExternalLink, WifiOff, RefreshCw, Globe, Lock, Server, ChevronDown, Copy, Check, KeyRound } from "lucide-react";
import type { WorkspacePort, PreviewPortMode } from "../api/client.js";

// Linux ephemeral port range (ip_local_port_range) — auto-assigned to transient
// / outbound sockets, never a deliberately-chosen dev server. Hidden by default
// to keep the picker to actual web services; revealed by "Show all".
const EPHEMERAL_MIN = 32768;

interface Props {
  url: string | null;
  refreshTrigger?: number; // increment to force iframe reload
  /** Detected listening services + per-port public state. */
  ports?: WorkspacePort[];
  /** Port currently shown in the iframe. */
  currentPort?: number | null;
  /** Legacy container-wide "expose everything" master flag (read-only hint). */
  publicPreview?: boolean;
  onSelectPort?: (port: number) => void;
  onSetPortAccess?: (port: number, mode: PreviewPortMode) => void;
  buildPortUrl?: (port: number) => string;
  onRescanPorts?: () => void;
}

// Dropdown listing every service the container is listening on. Lets the user
// switch which one the preview shows and expose any of them publicly — the
// fix for "only the frontend got picked, I can't make the backend public".
function PortPicker({
  ports, currentPort, publicPreview, onSelectPort, onSetPortAccess, buildPortUrl, onRescanPorts,
}: {
  ports: WorkspacePort[];
  currentPort?: number | null;
  publicPreview?: boolean;
  onSelectPort?: (port: number) => void;
  onSetPortAccess?: (port: number, mode: PreviewPortMode) => void;
  buildPortUrl?: (port: number) => string;
  onRescanPorts?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [showAll, setShowAll] = useState(false);
  const [copied, setCopied] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    // Clicks that land inside the preview iframe never reach this document, so
    // the iframe stealing focus (window blur) is our signal to close too.
    const onBlur = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("blur", onBlur);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", onBlur);
    };
  }, [open]);

  const currentMode = publicPreview ? "public" : ports.find((p) => p.port === currentPort)?.mode ?? "private";
  // Always keep the currently-shown port visible even if it's ephemeral.
  const isHidden = (p: WorkspacePort) => p.port >= EPHEMERAL_MIN && p.port !== currentPort;
  const visiblePorts = showAll ? ports : ports.filter((p) => !isHidden(p));
  const hiddenCount = ports.filter(isHidden).length;

  return (
    <div ref={ref} style={{ position: "relative", display: "inline-flex" }}>
      <button
        onClick={() => { setOpen((v) => !v); if (!open) onRescanPorts?.(); }}
        className="flex items-center gap-1"
        style={{
          padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 600,
          fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em",
          background: "var(--vz-card)", color: "var(--vz-muted)",
          border: "1px solid var(--vz-border)",
        }}
        title="Switch or expose a running service"
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <Server className="w-2.5 h-2.5" />
        {currentPort ? `:${currentPort}` : "ports"}
        {currentMode === "public" && <Globe className="w-2.5 h-2.5" style={{ color: "var(--vz-ok)" }} />}
        {currentMode === "code" && <KeyRound className="w-2.5 h-2.5" style={{ color: "var(--vz-sodium)" }} />}
        <ChevronDown className="w-2.5 h-2.5" />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute", top: "calc(100% + 6px)", right: 0, zIndex: 60,
            width: 240, padding: 6, borderRadius: 8,
            background: "var(--vz-page)", border: "1px solid var(--vz-border)",
            boxShadow: "0 10px 28px rgba(0,0,0,0.45)",
          }}
        >
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "4px 6px 6px" }}>
            <span style={{ fontSize: 10, letterSpacing: "0.08em", textTransform: "uppercase", color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)" }}>
              Running services
            </span>
            <button onClick={() => onRescanPorts?.()} title="Rescan" style={{ color: "var(--vz-muted-2)" }}>
              <RefreshCw className="w-3 h-3" />
            </button>
          </div>

          {ports.length === 0 && (
            <div style={{ padding: "8px 6px", fontSize: 11, color: "var(--vz-muted-2)" }}>
              No listening services detected.
            </div>
          )}

          {visiblePorts.map((p) => {
            const isCurrent = p.port === currentPort;
            const mode: PreviewPortMode = publicPreview ? "public" : p.mode;
            const linkWithCode = (base: string) => p.code ? `${base}${base.includes("?") ? "&" : "?"}__vzc_code=${encodeURIComponent(p.code)}` : base;
            const copy = (key: number, value: string) => {
              navigator.clipboard.writeText(value);
              setCopied(key); setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
            };
            return (
              <div
                key={p.port}
                style={{
                  padding: "5px 6px", borderRadius: 6,
                  background: isCurrent ? "var(--vz-sodium-08)" : "transparent",
                }}
              >
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <button
                    onClick={() => { onSelectPort?.(p.port); setOpen(false); }}
                    style={{ flex: 1, textAlign: "left", display: "flex", alignItems: "center", gap: 6, color: "var(--vz-ink)", fontSize: 12 }}
                    title={`Preview port ${p.port}`}
                  >
                    <span className="font-mono">:{p.port}</span>
                    {isCurrent && <span style={{ fontSize: 9, color: "var(--vz-sodium)", letterSpacing: "0.06em" }}>SHOWING</span>}
                  </button>

                  {buildPortUrl && (
                    <button
                      onClick={() => copy(p.port, linkWithCode(buildPortUrl(p.port)))}
                      title={mode === "public" ? "Copy public link" : mode === "code" ? "Copy link (includes the code)" : "Copy link (owner-only until shared)"}
                      style={{ color: "var(--vz-muted-2)" }}
                    >
                      {copied === p.port ? <Check className="w-3 h-3" style={{ color: "var(--vz-ok)" }} /> : <Copy className="w-3 h-3" />}
                    </button>
                  )}

                  {/* Private · Code · Public segmented control */}
                  <div style={{ display: "inline-flex", borderRadius: 4, overflow: "hidden", border: "1px solid var(--vz-border)", opacity: publicPreview ? 0.6 : 1 }}>
                    {([
                      { m: "private" as const, icon: <Lock className="w-2.5 h-2.5" />, c: "var(--vz-muted)" },
                      { m: "code" as const, icon: <KeyRound className="w-2.5 h-2.5" />, c: "var(--vz-sodium)" },
                      { m: "public" as const, icon: <Globe className="w-2.5 h-2.5" />, c: "var(--vz-ok)" },
                    ]).map((opt) => {
                      const active = mode === opt.m;
                      return (
                        <button
                          key={opt.m}
                          onClick={() => !publicPreview && !active && onSetPortAccess?.(p.port, opt.m)}
                          disabled={!!publicPreview}
                          title={opt.m === "private" ? "Private — only you" : opt.m === "code" ? "Public with access code" : "Public — anyone with the link"}
                          style={{
                            display: "grid", placeItems: "center", width: 22, height: 18,
                            background: active ? `color-mix(in srgb, ${opt.c} 16%, transparent)` : "transparent",
                            color: active ? opt.c : "var(--vz-muted-2)",
                          }}
                        >
                          {opt.icon}
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Code row: show the access code + a copy-with-code action. */}
                {mode === "code" && !publicPreview && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 4, paddingLeft: 2 }}>
                    <KeyRound className="w-2.5 h-2.5" style={{ color: "var(--vz-sodium)", flexShrink: 0 }} />
                    <code style={{ fontSize: 11, letterSpacing: "0.08em", color: "var(--vz-ink-2)" }}>{p.code ?? "—"}</code>
                    {p.code && (
                      <button onClick={() => copy(-p.port, p.code!)} title="Copy code" style={{ color: "var(--vz-muted-2)" }}>
                        {copied === -p.port ? <Check className="w-3 h-3" style={{ color: "var(--vz-ok)" }} /> : <Copy className="w-3 h-3" />}
                      </button>
                    )}
                    <button
                      onClick={() => onSetPortAccess?.(p.port, "code")}
                      title="Generate a new code (invalidates the old one)"
                      style={{ marginLeft: "auto", fontSize: 9, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em" }}
                    >
                      ↻ new
                    </button>
                  </div>
                )}
              </div>
            );
          })}

          {(hiddenCount > 0 || showAll) && ports.length > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{ width: "100%", textAlign: "left", padding: "5px 6px", marginTop: 2, fontSize: 10, color: "var(--vz-muted-2)", fontFamily: "var(--vz-font-mono)", letterSpacing: "0.04em" }}
              title="Ephemeral ports (≥32768) are usually internal sockets, not web servers"
            >
              {showAll ? "− Hide system ports" : `+ Show all ports (${hiddenCount} hidden)`}
            </button>
          )}

          {publicPreview && (
            <div style={{ padding: "6px 6px 2px", fontSize: 10, color: "var(--vz-muted-2)", lineHeight: 1.4 }}>
              This workspace exposes every port (container-wide). Per-port control is disabled.
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export function PreviewTab({
  url, refreshTrigger = 0, ports, currentPort, publicPreview, onSelectPort, onSetPortAccess, buildPortUrl, onRescanPorts,
}: Props) {
  const [loadError, setLoadError] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const iframeKey = `${url}-${refreshTrigger}-${manualRefresh}`;
  // Chrome renders PDFs via its built-in plugin viewer, which a `sandbox`d
  // iframe blocks ("This page has been blocked by Chrome") — there's no sandbox
  // token that re-enables it. Drop the sandbox for PDF previews; the content is
  // still cross-origin-isolated by same-origin policy. App previews keep the
  // sandbox (untrusted dev-server HTML/JS).
  const isPdf = !!url && /\.pdf(?:$|[?#])/i.test(url);

  useEffect(() => {
    setLoadError(false);
  }, [url, refreshTrigger, manualRefresh]);

  if (!url) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--vz-muted-2)" }}>
        <div className="text-center">
          <Globe className="w-8 h-8 mx-auto mb-2" style={{ color: "var(--vz-muted-2)" }} />
          <p style={{ color: "var(--vz-muted)" }}>No server running</p>
          <p className="text-xs mt-1">Start a dev server to see a live preview</p>
          {ports && ports.some((p) => p.port < EPHEMERAL_MIN) && onSelectPort && (
            <div className="mt-3 flex flex-wrap gap-1.5 justify-center">
              {ports.filter((p) => p.port < EPHEMERAL_MIN).map((p) => (
                <button
                  key={p.port}
                  onClick={() => onSelectPort(p.port)}
                  className="font-mono"
                  style={{ padding: "2px 8px", borderRadius: 4, fontSize: 11, border: "1px solid var(--vz-border)", color: "var(--vz-ink)" }}
                  title={`Preview port ${p.port}`}
                >
                  :{p.port}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    );
  }

  const isFileServer = /\-8000\.vonzio\.localhost/.test(url);
  const dotColor = loadError ? "var(--vz-warn)" : "var(--vz-ok)";

  return (
    <div className="flex-1 flex flex-col">
      <div
        className="flex items-center gap-2 px-3 py-1.5 text-xs"
        style={{
          background: "var(--vz-mute)",
          borderBottom: "1px solid var(--vz-border)",
        }}
      >
        <span className="w-1.5 h-1.5 rounded-full shrink-0" style={{ background: dotColor }} />
        <span className="flex-1 truncate font-mono" style={{ color: "var(--vz-ink-2)" }}>{url}</span>
        {onSelectPort && (
          <PortPicker
            ports={ports ?? []}
            currentPort={currentPort}
            publicPreview={publicPreview}
            onSelectPort={onSelectPort}
            onSetPortAccess={onSetPortAccess}
            buildPortUrl={buildPortUrl}
            onRescanPorts={onRescanPorts}
          />
        )}
        <button
          onClick={() => setManualRefresh((n) => n + 1)}
          className="vz-action-btn"
          style={{ width: 20, height: 20 }}
          title="Refresh preview"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="vz-action-btn"
          style={{ width: 20, height: 20 }}
        >
          <ExternalLink className="w-3 h-3" />
        </a>
      </div>
      {loadError ? (
        <div className="flex-1 flex items-center justify-center text-sm" style={{ color: "var(--vz-muted)" }}>
          <div className="text-center space-y-2">
            <WifiOff className="w-8 h-8 mx-auto" style={{ color: "var(--vz-warn)" }} />
            <p className="font-medium" style={{ color: "var(--vz-ink-2)" }}>Server may be offline</p>
            {!isFileServer && (
              <p className="text-xs max-w-[220px]" style={{ color: "var(--vz-muted-2)" }}>
                Ask the agent to start the server again, then the preview will reload.
              </p>
            )}
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-xs underline mt-1"
              style={{ color: "var(--vz-sodium)" }}
            >
              Try opening in new tab
            </a>
          </div>
        </div>
      ) : (
        <iframe
          key={iframeKey}
          src={url}
          className="flex-1 w-full border-0"
          sandbox={isPdf ? undefined : "allow-scripts allow-same-origin allow-forms allow-popups"}
          title="Preview"
          onError={() => setLoadError(true)}
          onLoad={(e) => {
            // If the iframe loaded successfully, clear any prior error state
            try {
              // Accessing contentDocument throws for cross-origin; treat that as loaded fine
              const doc = (e.target as HTMLIFrameElement).contentDocument;
              if (doc && doc.title === "" && doc.body?.innerHTML === "") {
                setLoadError(true);
              } else {
                setLoadError(false);
              }
            } catch {
              setLoadError(false);
            }
          }}
        />
      )}
    </div>
  );
}
