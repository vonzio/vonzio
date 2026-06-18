import type { VonzioConfig, VonzioAPI } from "./types";
import { STYLES } from "./styles";
import { Bubble } from "./bubble";
import { Panel } from "./panel";

declare global {
  interface Window {
    Vonzio?: VonzioAPI;
  }
}

(function () {
  const script = document.currentScript as HTMLScriptElement | null;
  if (!script) return;

  const data = script.dataset;
  const config: VonzioConfig = {
    key: data.key || "",
    profile: data.profile,
    mode: (data.mode as VonzioConfig["mode"]) || "floating",
    position:
      (data.position as VonzioConfig["position"]) || "bottom-right",
    title: data.title,
    theme: (data.theme as VonzioConfig["theme"]) || "light",
    placeholder: data.placeholder,
    open: data.open === "true",
    server: data.server,
  };

  // Determine server origin from the script src or the data-server attribute
  if (!config.server) {
    try {
      const srcUrl = new URL(script.src);
      config.server = srcUrl.origin;
    } catch {
      config.server = window.location.origin;
    }
  }

  // Fullpage mode: redirect to the chat URL
  if (config.mode === "fullpage") {
    const chatUrl = `${config.server}/chat?key=${encodeURIComponent(config.key)}&profile=${encodeURIComponent(config.profile || "")}&theme=${encodeURIComponent(config.theme || "light")}`;
    window.location.href = chatUrl;
    return;
  }

  // Floating mode: create bubble + panel in Shadow DOM
  const host = document.createElement("div");
  host.id = "vonzio-widget";
  document.body.appendChild(host);

  const shadow = host.attachShadow({ mode: "open" });

  const styleEl = document.createElement("style");
  styleEl.textContent = STYLES;
  shadow.appendChild(styleEl);

  const panel = new Panel(shadow, config);
  const bubble = new Bubble(shadow, config, () => panel.toggle());

  // Open on load if configured via data-open (Panel also restores from localStorage)
  if (config.open && !panel.isOpen()) {
    panel.open();
  }

  window.Vonzio = {
    open: () => panel.open(),
    close: () => panel.close(),
    toggle: () => panel.toggle(),
    destroy: () => {
      bubble.destroy();
      panel.destroy();
      host.remove();
      delete window.Vonzio;
    },
    on: (event, callback) => panel.on(event, callback),
    off: (event, callback) => panel.off(event, callback),
    getState: () => panel.getState(),
  };
})();
