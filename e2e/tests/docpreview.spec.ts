import { test, expect, type Page } from "@playwright/test";

/**
 * Office-document preview e2e (#368): the mock LLM (MOCK_SCENARIO=docx) emits
 * a Bash tool_use that creates a REAL docx inside the agent container, then
 * announces its path. The whole pipeline is exercised for real:
 *
 *   tool_result over ws → Workspace auto-open → Document deck tab →
 *   /preview/:id/docpreview/* → in-container LibreOffice docx→PDF →
 *   pdf.js renders a canvas.
 *
 * Runs via `make e2e-docs` (scripts/e2e-local.sh docs), which boots the
 * isolated stack with the scenario flag set.
 */

const ADMIN = {
  name: "E2E Admin",
  email: "e2e-admin@vonzio.local",
  password: "e2e-smoke-pw-2026",
};
const MOCK_MODEL = process.env.MOCK_MODEL || "mock-model";

function asArray(json: unknown): any[] {
  if (Array.isArray(json)) return json;
  const o = (json ?? {}) as Record<string, unknown>;
  return (o.profiles as any[]) ?? (o.data as any[]) ?? [];
}

test.describe.serial("document deck tab (mock docx scenario)", () => {
  test.skip(
    !process.env.VONZIO_E2E_DOCS,
    "document e2e needs the docx mock scenario — run via `make e2e-docs`"
  );

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close();
  });

  // Cold agent spawn + tool round-trip + first LibreOffice conversion.
  test.setTimeout(300_000);

  test("a generated docx auto-opens rendered in the deck", async () => {
    const setup = await page.request.post("/api/setup", {
      data: ADMIN,
      failOnStatusCode: false,
    });
    expect([200, 409]).toContain(setup.status());

    await page.goto("/login");
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

    let profiles = asArray(await (await page.request.get("/v1/profiles")).json());
    if (!profiles.length) {
      const cred = await page.request.post("/v1/anthropic-keys", {
        data: { name: "mock-llm", provider: "ollama", api_key: "mock-key-ignored" },
      });
      expect(cred.ok(), `credential create failed: ${cred.status()}`).toBeTruthy();
      profiles = asArray(await (await page.request.get("/v1/profiles")).json());
    }
    const pid = profiles[0].id as string;
    const patch = await page.request.patch(`/v1/profiles/${pid}`, {
      data: { model: MOCK_MODEL },
    });
    expect(patch.ok(), `set-model failed: ${patch.status()}`).toBeTruthy();

    await page.goto("/");
    const input = page.getByPlaceholder(/message vonzio/i);
    await expect(input, "chat composer should be visible").toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await input.fill("make me a report docx");
      await input.press("Enter");
      await expect(page).toHaveURL(/\/w\//, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });

    // The scripted turn announces the created file.
    await expect(page.getByText(/E2E_Report\.docx/).first()).toBeVisible({ timeout: 180_000 });

    // Auto-open: the Document tab appears and becomes active without clicks.
    const docTab = page.getByRole("tab", { name: "Document" });
    await expect(docTab, "Document deck tab should auto-open").toBeVisible({ timeout: 30_000 });
    await expect(docTab).toHaveAttribute("data-active", "true");

    // And it actually renders: pdf.js paints the converted PDF to a canvas.
    // First conversion runs LibreOffice cold inside the container — be patient.
    await expect(
      page.locator("canvas").first(),
      "converted docx should render as a PDF canvas"
    ).toBeVisible({ timeout: 120_000 });
  });
});
