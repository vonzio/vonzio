import { test, expect, type Page } from "@playwright/test";

/**
 * The first-run critical path, exactly as a new self-hoster experiences it on
 * a fresh OSS install:
 *
 *   1. /setup  — create the lone admin account (the only signup an OSS
 *                instance ever offers; it 409s forever after).
 *   2. /login  — sign in with those credentials.
 *   3. /onboarding — a signed-in user with zero profiles is routed into the
 *                "pick a provider" wizard (App.tsx → AppRoutesGuard).
 *
 * These three steps share ONE browser context (cookies/session persist across
 * them), so the suite is serial and reuses a single page. None of this touches
 * an LLM provider, so it's deterministic and free — the chat step (which does
 * need a provider) lives in chat.spec.ts behind a mock.
 *
 * Credentials are fixed; the suite requires a fresh DB, so there's no prior
 * admin to collide with. If you re-run against a dirty DB, step 1 will fail at
 * the /setup 409 — that's the signal to recreate the stack (`down -v`).
 */

const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@vonzio.local",
  password: "e2e-smoke-pw-2026",
};

test.describe.serial("OSS first-run", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("setup wizard creates the admin and hands off to login", async () => {
    await page.goto("/setup");

    // The wizard only renders on a fresh DB. Once an admin exists the route
    // 409s and the app redirects to /login, so the "Create admin account"
    // button — unique to this page — is the right liveness check: its absence
    // means the DB isn't fresh. Fail with a hint rather than a vague timeout.
    const createBtn = page.getByRole("button", {
      name: /create admin account/i,
    });
    await expect(
      createBtn,
      "expected the /setup wizard — is the DB fresh? (recreate the stack with `down -v`)"
    ).toBeVisible();

    await page.getByPlaceholder("Your name").fill(ADMIN.name);
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await createBtn.click();

    // Setup does a full window.location reload to /login once the admin exists.
    await expect(page).toHaveURL(/\/login/);
  });

  test("admin signs in and is routed into onboarding", async () => {
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();

    // A signed-in user with zero profiles lands on the onboarding wizard.
    await expect(page).toHaveURL(/\/onboarding/);
  });

  test("onboarding prompts the user to pick a provider", async () => {
    // Already at /onboarding from the previous step; assert the wizard's first
    // step rendered. We stop here — actually submitting a credential calls the
    // provider, which chat.spec.ts covers behind a mock.
    await expect(
      page.getByRole("heading", { name: /pick a provider/i })
    ).toBeVisible();
    await expect(page.getByText(/anthropic api key/i)).toBeVisible();
    await expect(page.getByText(/ollama cloud api key/i)).toBeVisible();
  });
});
