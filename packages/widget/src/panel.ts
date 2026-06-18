import type { VonzioConfig, VonzioEvent, VonzioState } from "./types";

const CLOSE_ICON_SVG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <line x1="18" y1="6" x2="6" y2="18"></line>
  <line x1="6" y1="6" x2="18" y2="18"></line>
</svg>`;

const NEW_CHAT_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8"></path>
  <path d="M21 3v5h-5"></path>
</svg>`;

const DOWNLOAD_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
  <polyline points="7 10 12 15 17 10"></polyline>
  <line x1="12" y1="15" x2="12" y2="3"></line>
</svg>`;

const MAXIMIZE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="15 3 21 3 21 9"></polyline>
  <polyline points="9 21 3 21 3 15"></polyline>
  <line x1="21" y1="3" x2="14" y2="10"></line>
  <line x1="3" y1="21" x2="10" y2="14"></line>
</svg>`;

const MINIMIZE_ICON_SVG = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
  <polyline points="4 14 10 14 10 20"></polyline>
  <polyline points="20 10 14 10 14 4"></polyline>
  <line x1="14" y1="10" x2="21" y2="3"></line>
  <line x1="3" y1="21" x2="10" y2="14"></line>
</svg>`;

export class Panel {
  private panel: HTMLDivElement;
  private iframe: HTMLIFrameElement;
  private _isOpen = false;
  private _isEnlarged = false;
  private _sessionId: string | null = null;
  private _messageCount = 0;
  private enlargeBtn: HTMLButtonElement;
  private messageHandler: (event: MessageEvent) => void;
  private listeners = new Map<VonzioEvent, Set<(data?: unknown) => void>>();
  private storageKey: string;
  private enlargedKey: string;

  constructor(
    container: ShadowRoot,
    private config: VonzioConfig,
  ) {
    const position = config.position || "bottom-right";
    const title = config.title || "Chat";
    const serverOrigin = config.server || "";
    this.storageKey = `vonzio_${config.key.slice(0, 12)}_open`;
    this.enlargedKey = `vonzio_${config.key.slice(0, 12)}_enlarged`;

    this.panel = document.createElement("div");
    this.panel.className = `rc-panel ${position} closed`;

    const header = document.createElement("div");
    header.className = "rc-panel-header";

    const titleEl = document.createElement("span");
    titleEl.className = "rc-panel-header-title";
    titleEl.textContent = title;

    const headerActions = document.createElement("div");
    headerActions.className = "rc-panel-header-actions";

    const downloadBtn = document.createElement("button");
    downloadBtn.className = "rc-panel-header-btn";
    downloadBtn.innerHTML = DOWNLOAD_ICON_SVG;
    downloadBtn.setAttribute("aria-label", "Download chat");
    downloadBtn.setAttribute("title", "Download chat");
    downloadBtn.addEventListener("click", () => this.requestTranscript());

    this.enlargeBtn = document.createElement("button");
    this.enlargeBtn.className = "rc-panel-header-btn";
    this.enlargeBtn.innerHTML = MAXIMIZE_ICON_SVG;
    this.enlargeBtn.setAttribute("aria-label", "Enlarge");
    this.enlargeBtn.setAttribute("title", "Enlarge");
    this.enlargeBtn.addEventListener("click", () => this.toggleEnlarge());

    const newChatBtn = document.createElement("button");
    newChatBtn.className = "rc-panel-header-btn";
    newChatBtn.innerHTML = NEW_CHAT_ICON_SVG;
    newChatBtn.setAttribute("aria-label", "New chat");
    newChatBtn.setAttribute("title", "New chat");
    newChatBtn.addEventListener("click", () => this.newChat());

    const closeBtn = document.createElement("button");
    closeBtn.className = "rc-panel-header-btn";
    closeBtn.innerHTML = CLOSE_ICON_SVG;
    closeBtn.setAttribute("aria-label", "Close chat");
    closeBtn.addEventListener("click", () => this.close());

    headerActions.appendChild(downloadBtn);
    headerActions.appendChild(this.enlargeBtn);
    headerActions.appendChild(newChatBtn);
    headerActions.appendChild(closeBtn);

    header.appendChild(titleEl);
    header.appendChild(headerActions);

    const iframeSrc = `${serverOrigin}/chat?key=${encodeURIComponent(config.key)}&profile=${encodeURIComponent(config.profile || "")}&theme=${encodeURIComponent(config.theme || "light")}&embedded=true`;

    this.iframe = document.createElement("iframe");
    this.iframe.src = iframeSrc;
    this.iframe.setAttribute("allow", "clipboard-write");
    this.iframe.setAttribute("title", title);

    this.panel.appendChild(header);
    this.panel.appendChild(this.iframe);
    container.appendChild(this.panel);

    this.messageHandler = (event: MessageEvent) => {
      if (event.origin !== new URL(iframeSrc, window.location.origin).origin) {
        return;
      }
      const data = event.data;
      if (data?.type === "vonzio:ready") {
        this.iframe.dataset.ready = "true";
        this.emit("ready");
      } else if (data?.type === "vonzio:message") {
        this._messageCount++;
        this.emit("message", data);
      } else if (data?.type === "vonzio:error") {
        this.emit("error", data);
      } else if (data?.type === "vonzio:sessionReady") {
        this._sessionId = data.sessionId ?? null;
      } else if (data?.type === "vonzio:transcript") {
        this.downloadMarkdown(data.markdown as string);
      }
    };
    window.addEventListener("message", this.messageHandler);

    // Restore open + enlarged state from localStorage
    try {
      if (localStorage.getItem(this.storageKey) === "true") {
        this.open();
      }
      if (localStorage.getItem(this.enlargedKey) === "true") {
        this._isEnlarged = true;
        this.applyEnlargedState();
      }
    } catch { /* private browsing */ }
  }

  private emit(event: VonzioEvent, data?: unknown): void {
    const set = this.listeners.get(event);
    if (set) {
      for (const cb of set) {
        try { cb(data); } catch { /* consumer error */ }
      }
    }
  }

  on(event: VonzioEvent, callback: (data?: unknown) => void): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(callback);
    return () => set!.delete(callback);
  }

  off(event: VonzioEvent, callback: (data?: unknown) => void): void {
    this.listeners.get(event)?.delete(callback);
  }

  getState(): VonzioState {
    return {
      isOpen: this._isOpen,
      sessionId: this._sessionId,
      messageCount: this._messageCount,
    };
  }

  toggleEnlarge(): void {
    this._isEnlarged = !this._isEnlarged;
    this.applyEnlargedState();
    try { localStorage.setItem(this.enlargedKey, String(this._isEnlarged)); } catch {}
  }

  private applyEnlargedState(): void {
    if (this._isEnlarged) {
      this.panel.classList.add("enlarged");
      this.enlargeBtn.innerHTML = MINIMIZE_ICON_SVG;
      this.enlargeBtn.setAttribute("title", "Reduce");
      this.enlargeBtn.setAttribute("aria-label", "Reduce");
    } else {
      this.panel.classList.remove("enlarged");
      this.enlargeBtn.innerHTML = MAXIMIZE_ICON_SVG;
      this.enlargeBtn.setAttribute("title", "Enlarge");
      this.enlargeBtn.setAttribute("aria-label", "Enlarge");
    }
  }

  requestTranscript(): void {
    if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "vonzio:downloadTranscript" }, "*");
    }
  }

  private downloadMarkdown(markdown: string): void {
    const blob = new Blob([markdown], { type: "text/markdown" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `chat-${new Date().toISOString().slice(0, 10)}.md`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  newChat(): void {
    this._messageCount = 0;
    this._sessionId = null;
    if (this.iframe.contentWindow) {
      this.iframe.contentWindow.postMessage({ type: "vonzio:newChat" }, "*");
    }
  }

  open(): void {
    this._isOpen = true;
    this.panel.classList.remove("closed");
    this.panel.classList.add("open");
    this.emit("open");
    try { localStorage.setItem(this.storageKey, "true"); } catch {}
  }

  close(): void {
    this._isOpen = false;
    this.panel.classList.remove("open");
    this.panel.classList.add("closed");
    this.emit("close");
    try { localStorage.setItem(this.storageKey, "false"); } catch {}
  }

  toggle(): void {
    if (this._isOpen) {
      this.close();
    } else {
      this.open();
    }
  }

  isOpen(): boolean {
    return this._isOpen;
  }

  destroy(): void {
    window.removeEventListener("message", this.messageHandler);
    this.listeners.clear();
    this.panel.remove();
  }
}
