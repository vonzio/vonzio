import { test, expect, type Page } from "@playwright/test";

/**
 * Chat round-trip against a MOCK provider — the product's core promise: send a
 * message, get a reply, deterministically and for free.
 *
 * How the mock is wired (see docker/docker-compose.e2e.yml + e2e/README.md):
 * the agent uses @anthropic-ai/claude-agent-sdk, so the chat path speaks the
 * Anthropic Messages API. We configure the profile with the `ollama` provider,
 * whose in-container proxy forwards the agent's LLM calls to OLLAMA_TARGET_URL
 * (= the server's OLLAMA_BASE_URL) — pointed at the `mock-llm` service, which
 * returns a canned "E2E pong". No real provider, no API key, no cost.
 *
 * This needs the full stack WITH a real agent image and the e2e overlay, so it
 * runs via `make e2e-chat` (or the e2e-chat CI dispatch), NOT the lightweight
 * first-run smoke. It is self-contained: it creates the admin, configures the
 * mock credential/model via the API, then drives the chat UI.
 */

const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@vonzio.local",
  password: "e2e-smoke-pw-2026",
};
const MOCK_MODEL = process.env.MOCK_MODEL || "mock-model";
const MOCK_REPLY = process.env.MOCK_REPLY || "E2E pong";

function asArray(json: unknown): any[] {
  if (Array.isArray(json)) return json;
  const o = (json ?? {}) as Record<string, unknown>;
  return (o.profiles as any[]) ?? (o.data as any[]) ?? [];
}

test.describe.serial("chat round-trip (mock provider)", () => {
  // This spec only works against the e2e overlay (mock LLM + real agent image)
  // — i.e. `make e2e-chat` / scripts/e2e-local.sh chat, which set this flag. In
  // a plain `npm run e2e` / the first-run CI job there's no mock, so skip it
  // (otherwise it fails on the model list AND its /api/setup pollutes the
  // first-run spec's fresh-DB assumption).
  test.skip(
    !process.env.VONZIO_E2E_CHAT,
    "chat E2E needs the mock LLM overlay — run via `make e2e-chat`"
  );

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  // Cold agent-container spawn + the SDK round-trip is far slower than the
  // 60s default; give the whole test room.
  test.setTimeout(240_000);

  test("configures a mock-backed agent and renders its canned reply", async () => {
    // 1. Ensure the admin exists (fresh stack → 200; re-run → 409, both fine).
    const setup = await page.request.post("/api/setup", {
      data: ADMIN,
      failOnStatusCode: false,
    });
    expect([200, 409]).toContain(setup.status());

    // 2. Log in through the UI so this context carries the session cookie.
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

    // 3. Configure the mock-backed agent via the API (page cookies apply):
    //    create an ollama credential (→ a profile), confirm the model list
    //    comes from the mock, and set it as the profile's model.
    let profiles = asArray(await (await page.request.get("/v1/profiles")).json());
    if (!profiles.length) {
      const cred = await page.request.post("/v1/anthropic-keys", {
        data: { name: "mock-llm", provider: "ollama", api_key: "mock-key-ignored" },
      });
      expect(cred.ok(), `credential create failed: ${cred.status()}`).toBeTruthy();
      profiles = asArray(await (await page.request.get("/v1/profiles")).json());
    }
    const pid = profiles[0].id as string;

    const models = await (await page.request.get(`/v1/profiles/${pid}/models`)).json();
    expect(
      (models.models ?? []).some((m: { id: string }) => m.id === MOCK_MODEL),
      "the mock model should be listed by /v1/profiles/:id/models"
    ).toBeTruthy();

    const patch = await page.request.patch(`/v1/profiles/${pid}`, {
      data: { model: MOCK_MODEL },
    });
    expect(patch.ok(), `set-model failed: ${patch.status()}`).toBeTruthy();

    // 4. Drive the chat UI: open the workspace and send a message. handleSend()
    //    silently no-ops until the async /v1/profiles fetch populates
    //    defaultProfileId (and it clears the input when it does), so retry
    //    fill+Enter until it actually starts a session and navigates to /w/:id.
    await page.goto("/");
    const input = page.getByPlaceholder(/message vonzio/i);
    await expect(input, "chat composer should be visible").toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await input.fill("ping");
      await input.press("Enter");
      await expect(page).toHaveURL(/\/w\//, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });

    // 5. The agent container spawns, calls the mock, and streams the canned
    //    reply back. Cold spawn + first token is slow, so allow generous time.
    await expect(page.getByText(MOCK_REPLY)).toBeVisible({ timeout: 180_000 });
  });
});
