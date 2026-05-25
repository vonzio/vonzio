/**
 * Wire-format constants for Telegram thread-claim (feature #18). Shared
 * between the message producer (NotificationService.sendViaTelegram, which
 * builds the inline_keyboard) and the consumer (telegram-events callback
 * dispatcher, which parses callback_data). A drifting prefix would silently
 * break the round-trip — keep them in one place.
 *
 * Telegram callback_data is capped at 64 bytes. Vonzio session ids are
 * `pb-<nanoid>` / similar (~22 chars), well under the limit.
 */
export const TC_CLAIM_PREFIX = "tc-claim:";
export const TC_DISMISS_PREFIX = "tc-dismiss:";

/**
 * Default-claim window. A Telegram playbook nudge auto-claims the chat
 * when the user replies within this window; older nudges expire silently.
 */
export const THREAD_CLAIM_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The one-line disclaimer prefixed to the user's prompt when an
 * auto-claim happens (so the agent's response opens with "[Switched to
 * <label> thread]").
 */
export function switchedThreadDisclaimer(label: string): string {
  return `[Switched to ${label} thread]`;
}

export const encodeThreadClaim = (sessionId: string) => `${TC_CLAIM_PREFIX}${sessionId}`;
export const encodeThreadDismiss = (sessionId: string) => `${TC_DISMISS_PREFIX}${sessionId}`;

/** Parse a thread-claim callback_data string. Returns null if it doesn't match. */
export function parseThreadCallback(data: string): { action: "claim" | "dismiss"; sessionId: string } | null {
  if (data.startsWith(TC_CLAIM_PREFIX)) {
    return { action: "claim", sessionId: data.slice(TC_CLAIM_PREFIX.length) };
  }
  if (data.startsWith(TC_DISMISS_PREFIX)) {
    return { action: "dismiss", sessionId: data.slice(TC_DISMISS_PREFIX.length) };
  }
  return null;
}
