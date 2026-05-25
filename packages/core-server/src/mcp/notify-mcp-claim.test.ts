import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./notify-mcp.js";

/**
 * Regression guard for feature #18 (Telegram thread-claim). The notify_user
 * tool grew two optional params — `claim_thread` and `claim_thread_label`.
 * Playbook prompts on prod reference them by name; an accidental rename
 * here would silently break delivery routing.
 */
describe("notify_user thread-claim params", () => {
  const notifyUser = TOOL_DEFINITIONS.find((t) => t.name === "notify_user");

  it("exposes claim_thread (boolean) and claim_thread_label (string)", () => {
    expect(notifyUser).toBeDefined();
    const props = notifyUser!.inputSchema.properties as Record<string, { type: string; description?: string }>;
    expect(props.claim_thread?.type).toBe("boolean");
    expect(props.claim_thread_label?.type).toBe("string");
  });

  it("does NOT require claim_thread (optional)", () => {
    const required = (notifyUser!.inputSchema as { required?: string[] }).required ?? [];
    expect(required).not.toContain("claim_thread");
    expect(required).not.toContain("claim_thread_label");
  });

  it("only 'message' is required", () => {
    const required = (notifyUser!.inputSchema as { required?: string[] }).required ?? [];
    expect(required).toEqual(["message"]);
  });
});
