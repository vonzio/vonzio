/**
 * Reachability ("presence") tracking for chat surfaces, used by the
 * orchestrator to tell the agent whether `AskUserQuestion` can actually
 * deliver to a human before it makes the call.
 *
 * Three signals:
 *   - dashboard: live WS subscription on this session_id RIGHT NOW
 *   - telegram:  a row in telegram_sessions binds this session to a chat
 *   - slack:     a row in slack_thread_mappings binds this session to a thread
 *
 * Dashboard is "is someone watching" — strict. Chat surfaces are "is the
 * channel still bound" — looser, since the user may not be near their
 * phone but Telegram will deliver the notification anyway.
 */

export interface Presence {
  dashboard: boolean;
  telegram: boolean;
  slack: boolean;
  any: boolean;
}

/**
 * Render the "Reachability" section injected into the agent's system
 * prompt. Three regimes drive different language:
 *
 *   - All three false → tell the agent NOT to call AskUserQuestion;
 *     this is a background task and the call would hang. Instructs
 *     a fallback strategy: assume, state, proceed.
 *   - Dashboard live → fast-reply mode. Question can be free-form.
 *   - Chat-only → still usable, but warn about latency and steer
 *     toward short button-style questions (phone-typing friction).
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

  const surfaces: string[] = [];
  if (presence.dashboard) surfaces.push("dashboard (live tab open — fastest reply)");
  if (presence.telegram) surfaces.push("Telegram (chat bound — may take minutes if the user isn't near their phone)");
  if (presence.slack) surfaces.push("Slack (thread bound — same latency caveat)");

  const lines = [
    "## Reachability",
    `Surfaces where the user can see and reply to you: ${surfaces.join(", ")}.`,
    "",
    "`AskUserQuestion` is available and will surface to the user on the surfaces above. Use it when you genuinely need a decision; don't use it to confirm things the user already implied.",
  ];
  if (!presence.dashboard && (presence.telegram || presence.slack)) {
    lines.push("");
    lines.push("The user is on a chat surface only, not the dashboard. Phrase questions as 2-4 short button options whenever possible — typing back free-form text from a phone is slow.");
  }
  return lines.join("\n");
}
