import { startCodexLogin, pollCodexLogin } from "../api/client.js";
import { DeviceSignInHint, DeviceSignInPanel, useDeviceSignIn, type DeviceFlow, type DeviceSignInState } from "./DeviceSignIn.js";

/** ChatGPT-subscription (Codex) device login, on the shared DeviceSignIn flow. */

export type ChatGptSignInState = DeviceSignInState;

const CODEX_FLOW: DeviceFlow = {
  start: async () => {
    const s = await startCodexLogin();
    return { ...s, poll: () => pollCodexLogin({ device_auth_id: s.device_auth_id, user_code: s.user_code }) };
  },
};

export function useChatGptSignIn(onConnected?: () => void): ChatGptSignInState {
  return useDeviceSignIn(CODEX_FLOW, onConnected);
}

/** ChatGPT ships with device sign-in disabled, so the flow dead-ends for
 *  most first-timers unless we point at the toggle. Shown while waiting and
 *  on failure (a rejected code / timeout is usually this, not a typo). */
const DEVICE_AUTH_HINT = (
  <DeviceSignInHint>
    If ChatGPT rejects the code, enable device sign-in first: <strong>Settings → Security and login → Enable device code authorization for Codex</strong>. ChatGPT keeps it off by default and only recommends it for headless or remote environments where the normal browser flow isn't available.
  </DeviceSignInHint>
);

export function ChatGptSignInPanel({ state }: { state: ChatGptSignInState }) {
  return <DeviceSignInPanel state={state} provider="ChatGPT" connected="Your ChatGPT subscription is ready to use." hint={DEVICE_AUTH_HINT} />;
}
