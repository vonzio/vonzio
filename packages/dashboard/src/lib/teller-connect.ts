/**
 * Lazy-loader + thin wrapper around Teller Connect's JS SDK
 * (https://teller.io/docs/api/connect). Loads the script once on first use
 * so the dashboard pays no cost when the user never opens Connect, and so
 * Teller's CDN isn't pinged on every page load.
 *
 * The SDK exposes a global `TellerConnect.setup(opts)` that returns an
 * object with `.open()` and `.destroy()`. The opaque event types are kept
 * minimal here — we only consume the bits the callback route needs.
 */

const CDN_URL = "https://cdn.teller.io/connect/connect.js";

export interface TellerConnectSuccess {
  accessToken: string;
  user?: { id?: string };
  enrollment: { id: string; institution: { id?: string; name?: string } };
  signature?: string;
}

export interface TellerConnectOptions {
  applicationId: string;
  environment?: "sandbox" | "development" | "production";
  /** Locale string (e.g. "en"). Optional; Teller picks a default. */
  selectAccount?: "disabled" | "single" | "multiple";
  onInit?: () => void;
  onSuccess: (enrollment: TellerConnectSuccess) => void;
  onExit?: () => void;
  onFailure?: (failure: { type: string; code?: string; message?: string }) => void;
}

interface TellerConnectGlobal {
  setup(opts: TellerConnectOptions): { open(): void; destroy(): void };
}

declare global {
  interface Window {
    TellerConnect?: TellerConnectGlobal;
  }
}

let scriptPromise: Promise<TellerConnectGlobal> | null = null;

function loadScript(): Promise<TellerConnectGlobal> {
  if (window.TellerConnect) return Promise.resolve(window.TellerConnect);
  if (scriptPromise) return scriptPromise;
  scriptPromise = new Promise<TellerConnectGlobal>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${CDN_URL}"]`);
    const script = existing ?? document.createElement("script");
    if (!existing) {
      script.src = CDN_URL;
      script.async = true;
      document.head.appendChild(script);
    }
    script.addEventListener("load", () => {
      if (window.TellerConnect) resolve(window.TellerConnect);
      else reject(new Error("Teller Connect SDK loaded but TellerConnect global is missing"));
    });
    script.addEventListener("error", () => {
      scriptPromise = null;
      reject(new Error("Failed to load Teller Connect SDK"));
    });
  });
  return scriptPromise;
}

export async function openTellerConnect(opts: TellerConnectOptions): Promise<void> {
  const sdk = await loadScript();
  sdk.setup(opts).open();
}
