/**
 * Reachability ("presence") tracking for chat surfaces, used by the
 * orchestrator to tell the agent whether `AskUserQuestion` can actually
 * deliver to a human before it makes the call.
 *
 * Two layers of signal:
 *   - dashboard: live WS subscription on this session_id RIGHT NOW
 *     (in-process; orchestrator checks SessionRegistry directly)
 *   - surfaces:  one or more chat-surface providers (telegram,
 *     slack, ...) reporting the session as bound to their channel.
 *     Sourced from SessionPresenceRegistry; each provider supplies
 *     its own agent-visible label.
 *
 * Dashboard is "is someone watching" -- strict. Chat surfaces are
 * "is the channel still bound" -- looser, since the user may not be
 * near their phone but Telegram/Slack will deliver the notification
 * anyway. The `slow` metadata flag on a surface drives the "phrase
 * as 2-4 button options" steer at the end of the section.
 */

import type { PresenceSurfaceMetadata } from "@vonzio/plugin-api";

export interface Presence {
  dashboard: boolean;
  /**
   * Active chat-bound surfaces, in registration order (telegram,
   * then slack today; whatever plugins register tomorrow). Each
   * surface contributes its own labelled line in the Reachability
   * section.
   */
  surfaces: PresenceSurfaceMetadata[];
  /** True iff dashboard OR at least one surface is reachable. */
  any: boolean;
}

/**
 * Render the "Reachability" section injected into the agent's system
 * prompt. Three regimes drive different language:
 *
 *   - All sources false → tell the agent NOT to call AskUserQuestion;
 *     this is a background task and the call would hang. Instructs
 *     a fallback strategy: assume, state, proceed.
 *   - Dashboard live → fast-reply mode. Question can be free-form.
 *   - Chat-only with a `slow` surface → still usable, but warn about
 *     latency and steer toward short button-style questions
 *     (phone-typing friction).
 *
 * Returned with a leading `## Reachability` header so it slots into the
 * system-prompt template alongside the other named sections.
 */
export function buildPresenceSection(presence: Presence): string {
  if (!presence.any) {
    return [
      "## Reachability",
      "No human is currently attached to this session (no dashboard tab open, no Telegram/Slack chat bound). This is a background task.",
      "",
      "**Do NOT call `AskUserQuestion`** — there is no surface to deliver the question to and the call will hang until timeout. When you need a decision you'd normally ask about:",
      "1. Make the most reasonable assumption you can.",
      "2. State the assumption explicitly in your final response so the user can correct it later.",
      "3. Proceed with the work.",
    ].join("\n");
  }

  const labelled: string[] = [];
  if (presence.dashboard) labelled.push("dashboard (live tab open — fastest reply)");
  for (const s of presence.surfaces) labelled.push(s.label);

  const lines = [
    "## Reachability",
    `Surfaces where the user can see and reply to you: ${labelled.join(", ")}.`,
    "",
    "`AskUserQuestion` is available and will surface to the user on the surfaces above. Use it when you genuinely need a decision; don't use it to confirm things the user already implied.",
  ];
  // Phone-only steer fires only when dashboard isn't live AND at least
  // one of the bound surfaces is marked `slow` (phone-typing friction).
  const anySlow = presence.surfaces.some((s) => s.slow);
  if (!presence.dashboard && anySlow) {
    lines.push("");
    lines.push("The user is on a chat surface only, not the dashboard. Phrase questions as 2-4 short button options whenever possible — typing back free-form text from a phone is slow.");
  }
  return lines.join("\n");
}
