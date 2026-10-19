import { startOpencodeLogin, pollOpencodeLogin } from "../api/client.js";
import { DeviceSignInHint, DeviceSignInPanel, useDeviceSignIn, type DeviceFlow, type DeviceSignInState } from "./DeviceSignIn.js";

/** OpenCode device sign-in, on the shared DeviceSignIn flow. The approval
 *  page on opencode.ai names the client "vonzio". */

export type OpencodeSignInState = DeviceSignInState;

const OPENCODE_FLOW: DeviceFlow = {
  start: async () => {
    const s = await startOpencodeLogin();
    return { ...s, poll: () => pollOpencodeLogin({ device_code: s.device_code }) };
  },
};

export function useOpencodeSignIn(onConnected?: () => void): OpencodeSignInState {
  return useDeviceSignIn(OPENCODE_FLOW, onConnected);
}

const PAID_PLAN_HINT = (
  <DeviceSignInHint>
    vonzio runs on OpenCode's paid models. OpenCode's free tier only works in OpenCode's own apps, so a paid plan is needed.
  </DeviceSignInHint>
);

export function OpencodeSignInPanel({ state }: { state: OpencodeSignInState }) {
  return <DeviceSignInPanel state={state} provider="OpenCode" connected="Your OpenCode account is ready to use." hint={PAID_PLAN_HINT} />;
}
