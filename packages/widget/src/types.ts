export interface VonzioConfig {
  key: string;
  profile?: string;
  mode?: "floating" | "fullpage";
  position?: "bottom-right" | "bottom-left";
  title?: string;
  theme?: "light" | "dark";
  placeholder?: string;
  open?: boolean;
  server?: string;
}

export type VonzioEvent = "ready" | "open" | "close" | "message" | "error";

export interface VonzioState {
  isOpen: boolean;
  sessionId: string | null;
  messageCount: number;
}

export interface VonzioAPI {
  open: () => void;
  close: () => void;
  toggle: () => void;
  destroy: () => void;
  on: (event: VonzioEvent, callback: (data?: unknown) => void) => () => void;
  off: (event: VonzioEvent, callback: (data?: unknown) => void) => void;
  getState: () => VonzioState;
}
