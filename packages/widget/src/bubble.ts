import type { VonzioConfig } from "./types";

const CHAT_ICON_SVG = `<svg class="rc-bubble-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
  <path d="M7 9h2v2H7zm4 0h2v2h-2zm4 0h2v2h-2z"/>
</svg>`;

export class Bubble {
  private button: HTMLButtonElement;
  private badge: HTMLSpanElement;

  constructor(
    container: ShadowRoot,
    config: VonzioConfig,
    onToggle: () => void,
  ) {
    const position = config.position || "bottom-right";

    this.button = document.createElement("button");
    this.button.className = `rc-bubble ${position}`;
    this.button.innerHTML = CHAT_ICON_SVG;
    this.button.setAttribute("aria-label", config.title || "Open chat");
    this.button.addEventListener("click", onToggle);

    this.badge = document.createElement("span");
    this.badge.className = "rc-badge hidden";
    this.badge.textContent = "0";
    this.button.appendChild(this.badge);

    container.appendChild(this.button);
  }

  setBadge(count: number): void {
    if (count > 0) {
      this.badge.textContent = count > 99 ? "99+" : String(count);
      this.badge.classList.remove("hidden");
    } else {
      this.badge.classList.add("hidden");
    }
  }

  destroy(): void {
    this.button.remove();
  }
}
