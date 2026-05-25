import { useState, useEffect, useRef } from "react";
import { WsClient } from "../api/ws.js";

export function useWebSocket() {
  const clientRef = useRef<WsClient | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const client = new WsClient(`${protocol}//${window.location.host}/v1/stream`);

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
