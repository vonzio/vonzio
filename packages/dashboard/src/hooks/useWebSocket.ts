import { useState, useEffect, useRef } from "react";
import { WsClient } from "../api/ws.js";

// Browsers can't set custom headers on WebSocket upgrade, so we
// append the active org id as a query param. Server-side cp-server
// reads it as a fallback to X-Org-Id. SaaS only — OSS leaves the
// localStorage key unset → no query param → no behavior change.
function wsOrgIdQuery(): string {
  if (typeof localStorage === "undefined") return "";
  try {
    const id = localStorage.getItem("vonzio_current_org_id");
    return id ? `?org_id=${encodeURIComponent(id)}` : "";
  } catch {
    return "";
  }
}

export function useWebSocket() {
  const clientRef = useRef<WsClient | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const client = new WsClient(`${protocol}//${window.location.host}/v1/stream${wsOrgIdQuery()}`);

    client.on("__connected", () => setConnected(true));
    client.on("__disconnected", () => setConnected(false));

    client.connect();
    clientRef.current = client;

    return () => {
      client.disconnect();
      clientRef.current = null;
    };
  }, []);

  return { client: clientRef.current, connected };
}
