export const STYLES = `
  @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600&display=swap');

  :host {
    /* vonzio brand — Deep Ocean palette. The chat UI itself is the /chat
       iframe (already on-brand via the dashboard); these tokens style the
       widget chrome (bubble, header, badge). */
    --rc-primary: #00BFA5;        /* teal — brand accent (the "v" mark) */
    --rc-primary-hover: #00A892;
    --rc-header-bg: #0F2B46;      /* navy — brand primary */
    --rc-bg: #ffffff;
    --rc-text: #0F2B46;
    --rc-border: #e2e8f0;
    --rc-badge: #FF6B35;          /* coral */
    --rc-shadow: 0 8px 30px rgba(15, 43, 70, 0.18);
    --rc-bubble-size: 56px;
    --rc-panel-width: 400px;
    --rc-panel-height: 600px;
    --rc-radius: 14px;
    --rc-transition: 0.2s ease;

    all: initial;
    font-family: "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
  }

  .rc-bubble {
    position: fixed;
    width: var(--rc-bubble-size);
    height: var(--rc-bubble-size);
    border-radius: 50%;
    background: var(--rc-primary);
    border: none;
    cursor: pointer;
    box-shadow: var(--rc-shadow);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: transform var(--rc-transition), background var(--rc-transition);
    z-index: 2147483646;
    padding: 0;
  }

  .rc-bubble:hover {
    transform: scale(1.08);
    background: var(--rc-primary-hover);
  }

  .rc-bubble:active {
    transform: scale(0.95);
  }

  .rc-bubble.bottom-right {
    bottom: 20px;
    right: 20px;
  }

  .rc-bubble.bottom-left {
    bottom: 20px;
    left: 20px;
  }

  .rc-bubble-icon {
    width: 24px;
    height: 24px;
    fill: #ffffff;
    pointer-events: none;
  }

  .rc-badge {
    position: absolute;
    top: -4px;
    right: -4px;
    background: var(--rc-badge);
    color: #ffffff;
    font-size: 11px;
    font-weight: 600;
    min-width: 18px;
    height: 18px;
    border-radius: 9px;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0 4px;
    box-sizing: border-box;
    line-height: 1;
  }

  .rc-badge.hidden {
    display: none;
  }

  .rc-panel {
    position: fixed;
    width: var(--rc-panel-width);
    height: var(--rc-panel-height);
    background: var(--rc-bg);
    border-radius: var(--rc-radius);
    box-shadow: var(--rc-shadow);
    overflow: hidden;
    display: flex;
    flex-direction: column;
    z-index: 2147483647;
    transition: opacity var(--rc-transition), transform var(--rc-transition);
  }

  .rc-panel.bottom-right {
    bottom: 90px;
    right: 20px;
  }

  .rc-panel.bottom-left {
    bottom: 90px;
    left: 20px;
  }

  .rc-panel.enlarged {
    width: calc(100vw - 40px);
    height: calc(100vh - 40px);
    bottom: 20px;
    right: 20px;
    left: 20px;
    border-radius: 16px;
    transition: width var(--rc-transition), height var(--rc-transition), bottom var(--rc-transition), right var(--rc-transition), left var(--rc-transition);
  }

  .rc-panel.enlarged.bottom-left {
    right: 20px;
  }

  .rc-panel.open {
    opacity: 1;
    transform: translateY(0);
    pointer-events: auto;
  }

  .rc-panel.closed {
    opacity: 0;
    transform: translateY(20px);
    pointer-events: none;
  }

  .rc-panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 12px 16px;
    background: var(--rc-header-bg);
    color: #ffffff;
    font-size: 14px;
    font-weight: 600;
    flex-shrink: 0;
  }

  .rc-panel-header-title {
    margin: 0;
    font-size: 14px;
    font-weight: 600;
  }

  .rc-panel-header-actions {
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .rc-panel-header-btn {
    background: none;
    border: none;
    color: #ffffff;
    cursor: pointer;
    padding: 4px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    opacity: 0.7;
    transition: opacity var(--rc-transition);
  }

  .rc-panel-header-btn:hover {
    opacity: 1;
  }

  .rc-panel iframe {
    width: 100%;
    height: 100%;
    border: none;
    flex: 1;
  }
`;
