import { describe, it, expect } from "vitest";
import type { McpServerSpec } from "@vonzio/plugin-api";
import { buildPluginMcpInjection, type McpSessionIdentity } from "./plugin-mcp.js";

const ID: McpSessionIdentity = { userId: "u1", profileId: "p1", orgId: null };
const base = "http://host.docker.internal:3000";
const httpSpec = (name: string, url: string): McpServerSpec => ({ name, transport: { type: "http", url } });

// Deterministic token minter for assertions (no Date.now/random in tests).
function counter(prefix = "tok") {
  let n = 0;
  return () => `${prefix}_${++n}`;
}

describe("buildPluginMcpInjection", () => {
  it("returns nothing when there is no registry or no internal server URL", () => {
    const reg = { list: () => [httpSpec("teller", "/plugins/teller/mcp")] };
    expect(buildPluginMcpInjection(undefined, base, ID, counter())).toEqual({ servers: [], tokens: [] });
    expect(buildPluginMcpInjection(reg, undefined, ID, counter())).toEqual({ servers: [], tokens: [] });
  });

  it("composes a leading-'/' url as a path under the internal server URL", () => {
    const reg = { list: () => [httpSpec("teller", "/plugins/teller/mcp")] };
    const { servers } = buildPluginMcpInjection(reg, base, ID, counter());
    expect(servers[0].url).toBe(`${base}/plugins/teller/mcp`);
  });

  it("passes an absolute url through unchanged", () => {
    const reg = { list: () => [httpSpec("ext", "https://mcp.example.com/rpc")] };
    const { servers } = buildPluginMcpInjection(reg, base, ID, counter());
    expect(servers[0].url).toBe("https://mcp.example.com/rpc");
  });

  it("skips stdio specs (not reachable as a shared http endpoint)", () => {
    const reg = {
      list: (): McpServerSpec[] => [
        { name: "local", transport: { type: "stdio", command: "node", args: ["x.js"] } },
        httpSpec("teller", "/plugins/teller/mcp"),
      ],
    };
    const { servers, tokens } = buildPluginMcpInjection(reg, base, ID, counter());
    expect(servers.map((s) => s.name)).toEqual(["teller"]);
    expect(tokens).toHaveLength(1);
  });

  it("mints a unique bearer token per http spec and carries the identity", () => {
    const reg = { list: () => [httpSpec("a", "/a"), httpSpec("b", "/b")] };
    const { servers, tokens } = buildPluginMcpInjection(reg, base, ID, counter());
    expect(tokens.map((t) => t.token)).toEqual(["tok_1", "tok_2"]);
    expect(new Set(tokens.map((t) => t.token)).size).toBe(2);
    expect(servers[0].headers.Authorization).toBe("Bearer tok_1");
    expect(servers[1].headers.Authorization).toBe("Bearer tok_2");
    expect(tokens.every((t) => t.identity === ID)).toBe(true);
  });
});

// Mirrors how the orchestrator wires the injection into its per-task token map
// and how ctx.mcpSessions.resolve reads it back — the mint -> resolve -> clear
// cycle a plugin's MCP route depends on.
describe("mcp session token round-trip (orchestrator + ctx.mcpSessions)", () => {
  it("resolves a minted token to its identity, and returns null after cleanup", () => {
    const tokenMap = new Map<string, McpSessionIdentity>();
    const reg = { list: () => [httpSpec("teller", "/plugins/teller/mcp")] };

    const { servers, tokens } = buildPluginMcpInjection(reg, base, ID, counter());
    for (const { token, identity } of tokens) tokenMap.set(token, identity);

    // ctx.mcpSessions.resolve delegates to the orchestrator's map.
    const resolve = (t: string): McpSessionIdentity | null => tokenMap.get(t) ?? null;
    const minted = servers[0].headers.Authorization.slice("Bearer ".length);

    expect(resolve(minted)).toEqual({ userId: "u1", profileId: "p1", orgId: null });
    expect(resolve("not-a-real-token")).toBeNull();

    tokenMap.delete(minted); // task cleanup
    expect(resolve(minted)).toBeNull();
  });
});
