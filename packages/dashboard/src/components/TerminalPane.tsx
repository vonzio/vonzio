import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

/**
 * A single PTY pane: one xterm.js terminal wired to one shell on the
 * workspace container (`/v1/workspaces/:id/terminal?term=<terminalId>`). It
 * stays MOUNTED while its parent lives — hidden via `visible=false` rather
 * than unmounted — so the shell (and anything running in it) survives tab
 * switches. When shown again it refits to the panel and refocuses.
 */
export function TerminalPane({
  workspaceId,
  terminalId,
  visible,
  onExit,
}: {
  workspaceId: string;
  terminalId: string;
  visible: boolean;
  onExit?: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "var(--vz-font-mono, ui-monospace, monospace)",
      fontSize: 13,
      theme: { background: "#0a0a0a", foreground: "#e4e4e7" },
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    safeFit(fit);

    const token = localStorage.getItem("vonzio_admin_token") ?? "";
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    const ws = new WebSocket(
      `${proto}//${window.location.host}/v1/workspaces/${workspaceId}/terminal` +
        `?term=${encodeURIComponent(terminalId)}&token=${encodeURIComponent(token)}`,
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
    };

    ws.onopen = () => { sendResize(); if (visible) term.focus(); };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") {
        try {
          const msg = JSON.parse(e.data);
          if (msg.type === "exit") {
            term.write(`\r\n\x1b[90m[process exited${msg.code != null ? ` with code ${msg.code}` : ""}]\x1b[0m\r\n`);
            onExit?.();
          }
        } catch { /* ignore */ }
      } else {
        term.write(new Uint8Array(e.data as ArrayBuffer));
      }
    };

    const onData = term.onData((data) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "stdin", data }));
    });

    // Refit + notify the PTY whenever the host actually changes size. While
    // hidden (display:none) the host is 0×0; safeFit skips those so xterm
    // isn't clamped to a 1-row terminal.
    const ro = new ResizeObserver(() => { if (safeFit(fit)) sendResize(); });
    ro.observe(hostRef.current);

    return () => {
      ro.disconnect();
      onData.dispose();
      ws.onmessage = null;
      ws.onopen = null;
      try { ws.close(); } catch { /* noop */ }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      wsRef.current = null;
    };
    // Mount once per (workspace, terminal). visible changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, terminalId]);

  // On becoming visible, refit (host went 0×0 → real) and refocus.
  useEffect(() => {
    if (!visible) return;
    const fit = fitRef.current, term = termRef.current, ws = wsRef.current;
    if (!fit || !term) return;
    // rAF: wait for the display flip to lay out before measuring.
    const raf = requestAnimationFrame(() => {
      if (safeFit(fit) && ws?.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
      }
      term.focus();
    });
    return () => cancelAnimationFrame(raf);
  }, [visible]);

  return (
    <div
      ref={hostRef}
      style={{ display: visible ? "block" : "none", width: "100%", height: "100%", padding: 6 }}
    />
  );
}

/** Fit only when the host has real dimensions. Returns whether it fit. */
function safeFit(fit: FitAddon): boolean {
  try {
    const dims = fit.proposeDimensions();
    if (!dims || !Number.isFinite(dims.cols) || !Number.isFinite(dims.rows) || dims.cols < 1 || dims.rows < 1) {
      return false;
    }
    fit.fit();
    return true;
  } catch {
    return false;
  }
}
