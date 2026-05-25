import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./notify-mcp.js";
import { NOTIFICATION_CHANNELS } from "@vonzio/shared";

/**
 * Regression guard for the notify_user channel param. The enum used to be
 * strictly [...NOTIFICATION_CHANNELS], but feature #18 (Telegram thread-
 * claim) needs the agent to pass `telegram:<integration_id>` for a
 * specific bot — which fails strict enum validation. The schema now
 * documents accepted forms in the description and lets the server
 * validate at routing time. These tests pin:
 *   - the enum is NOT enforced (so "telegram:<id>" is callable)
 *   - the description still lists every channel from NOTIFICATION_CHANNELS
 *     so an LLM picking from descriptions can find every supported sink.
 */
describe("notify-mcp tool schema", () => {
  const notifyUser = TOOL_DEFINITIONS.find((t) => t.name === "notify_user")!;

  it("channel param has no enum constraint (must accept 'telegram:<id>')", () => {
    const channelProp = notifyUser.inputSchema.properties.channel as { enum?: string[] };
    expect(channelProp.enum).toBeUndefined();
  });

  it("channel description mentions every NOTIFICATION_CHANNELS value", () => {
    const channelProp = notifyUser.inputSchema.properties.channel as { description?: string };
    const desc = channelProp.description ?? "";
    for (const c of NOTIFICATION_CHANNELS) {
      expect(desc, `description must mention "${c}"`).toContain(c);
    }
  });
});
