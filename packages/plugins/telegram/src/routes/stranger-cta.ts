/**
 * Throttle for the platform bot's reply to UNLINKED senders ("stranger
 * CTA"). The webhook is unauthenticated and this path triggers an
 * outbound send, which makes it a spam/DoS amplifier without limits
 * (June-2026 audit class). Two independent brakes:
 *
 *   - per chat: at most one CTA per `perChatMs` (default 6h) — a person
 *     poking the bot repeatedly gets one pointer, not an echo wall;
 *   - instance-wide: at most `perMinuteMax` CTAs per minute (default
 *     20) — a flood of forged updates can't turn the bot into a spam
 *     cannon no matter how many distinct chat ids it invents.
 *
 * Process-local state, same idiom as the webhook's seenUpdateIds dedup:
 * a restart forgetting the throttle is acceptable (worst case one extra
 * CTA per chat).
 */
export interface StrangerCtaGate {
  /** True → caller may send the CTA now (counts the send). */
  allow(chatId: string, now?: number): boolean;
}

export function createStrangerCtaGate(opts?: {
  perChatMs?: number;
  perMinuteMax?: number;
}): StrangerCtaGate {
  const perChatMs = opts?.perChatMs ?? 6 * 60 * 60 * 1000;
  const perMinuteMax = opts?.perMinuteMax ?? 20;
  const lastByChat = new Map<string, number>();
  let windowStart = 0;
  let windowCount = 0;

  return {
    allow(chatId: string, now: number = Date.now()): boolean {
      if (now - windowStart >= 60_000) {
        windowStart = now;
        windowCount = 0;
      }
      if (windowCount >= perMinuteMax) return false;
      const last = lastByChat.get(chatId);
      if (last !== undefined && now - last < perChatMs) return false;
      lastByChat.set(chatId, now);
      windowCount++;
      // Bound growth under a forged-chat-id flood: sweep expired
      // entries once the map gets large. The per-minute cap already
      // limits how fast it can grow.
      if (lastByChat.size > 5000) {
        for (const [k, v] of lastByChat) {
          if (now - v >= perChatMs) lastByChat.delete(k);
        }
      }
      return true;
    },
  };
}
