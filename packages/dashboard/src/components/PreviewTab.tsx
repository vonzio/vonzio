import { useState, useEffect } from "react";
import { ExternalLink, WifiOff, RefreshCw, Globe, Lock } from "lucide-react";

interface Props {
  url: string | null;
  refreshTrigger?: number; // increment to force iframe reload
  isPublic?: boolean;
  onTogglePublic?: (isPublic: boolean) => void;
}

export function PreviewTab({ url, refreshTrigger = 0, isPublic = false, onTogglePublic }: Props) {
  const [loadError, setLoadError] = useState(false);
  const [manualRefresh, setManualRefresh] = useState(0);
  const iframeKey = `${url}-${refreshTrigger}-${manualRefresh}`;

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
        {onTogglePublic && (
          <button
            onClick={() => onTogglePublic(!isPublic)}
            className="flex items-center gap-1 transition-colors"
            style={{
              padding: "1px 6px",
              borderRadius: 4,
              fontSize: 10,
              fontWeight: 600,
              fontFamily: "var(--vz-font-mono)",
              letterSpacing: "0.06em",
              textTransform: "uppercase",
              background: isPublic ? "color-mix(in srgb, var(--vz-ok) 14%, transparent)" : "var(--vz-card)",
              color: isPublic ? "var(--vz-ok)" : "var(--vz-muted)",
              border: `1px solid ${isPublic ? "color-mix(in srgb, var(--vz-ok) 35%, transparent)" : "var(--vz-border)"}`,
            }}
            title={isPublic ? "Preview is public — anyone with the link can view" : "Preview is private — only you can view"}
          >
            {isPublic ? <Globe className="w-2.5 h-2.5" /> : <Lock className="w-2.5 h-2.5" />}
            {isPublic ? "Public" : "Private"}
          </button>
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
          sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
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
