import { describe, it, expect } from "vitest";
import { TOOL_DEFINITIONS } from "./teller-mcp.js";

describe("teller-mcp tool schema", () => {
  const TOOL_NAMES = TOOL_DEFINITIONS.map((t) => t.name);

  it("exposes the five expected tools", () => {
    expect(TOOL_NAMES).toEqual([
      "teller_list_enrollments",
      "teller_list_accounts",
      "teller_get_balance",
      "teller_list_transactions",
      "teller_get_account_details",
    ]);
  });

  it("teller_list_enrollments takes no arguments", () => {
    const tool = TOOL_DEFINITIONS.find((t) => t.name === "teller_list_enrollments")!;
    expect(tool.inputSchema.properties ?? {}).toEqual({});
    expect("required" in tool.inputSchema).toBe(false);
  });

  it("per-enrollment tools require enrollment_id", () => {
    for (const name of ["teller_list_accounts", "teller_get_balance", "teller_list_transactions", "teller_get_account_details"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      expect(required, `${name} should require enrollment_id`).toContain("enrollment_id");
    }
  });

  it("account-scoped tools require account_id", () => {
    for (const name of ["teller_get_balance", "teller_list_transactions", "teller_get_account_details"]) {
      const tool = TOOL_DEFINITIONS.find((t) => t.name === name)!;
      const required = (tool.inputSchema as { required?: string[] }).required ?? [];
      expect(required, `${name} should require account_id`).toContain("account_id");
    }
  });
});
