import { test, expect } from "@playwright/test";
import { startMockProvider, MOCK_REPLY } from "../helpers/mock-provider";

/**
 * Chat round-trip — the product's core promise: send a message, get a reply.
 *
 * SKIPPED for now: it's the most valuable flow but also the only one that
 * needs the LLM provider, and wiring a deterministic mock end-to-end has two
 * moving parts that depend on how the stack is launched. The harness, the mock
 * provider (helpers/mock-provider.ts), and the test body below are all written
 * — un-skip once the two TODOs are wired. Keeping it skipped (not deleted)
 * makes the remaining work concrete and reviewable.
 *
 * Plan to finish it:
 *  1. NETWORK REACH. The agent calls the provider from inside its container, so
 *     mock.url must be reachable from there. Either:
 *       - start the mock bound to 0.0.0.0 and use http://host.docker.internal:<port>
 *         as the credential base URL (add `extra_hosts: ["host.docker.internal:host-gateway"]`
 *         to the agent/server service in docker-compose.dev.yml — already common
 *         for dev), or
 *       - run the mock as a tiny sidecar on the compose network and reference it
 *         by service name.
 *  2. CREDENTIAL. The onboarding UI only offers Anthropic/Ollama, so create an
 *     OpenAI-compatible credential with base URL = mock.url directly via the API
 *     (POST /v1/anthropic-keys or the credentials route) using an admin session,
 *     then PATCH the profile's model to MOCK_MODEL — the same shape we set up by
 *     hand during release testing. Drive the rest through the UI.
 *
 * Then the assertion is simply: the assistant bubble shows MOCK_REPLY and
 * mock.requests is non-empty (proves the agent actually hit our endpoint).
 */
test.describe.skip("chat round-trip (needs mock provider wiring)", () => {
  test("sends a message and renders the assistant reply", async ({ page, request }) => {
    const mock = await startMockProvider();
    try {
      // TODO(1): ensure mock.url is reachable from the agent container.
      // TODO(2): create an openai-compatible credential pointing at mock.url
      //          and set the profile model to MOCK_MODEL via `request`.
      void request; // (used once TODO(2) is wired)

      await page.goto("/");
      const input = page.getByRole("textbox", { name: /message|chat|prompt/i });
      await input.fill("ping");
      await input.press("Enter");

      await expect(page.getByText(MOCK_REPLY)).toBeVisible();
      expect(mock.requests.length).toBeGreaterThan(0);
    } finally {
      await mock.close();
    }
  });
});
