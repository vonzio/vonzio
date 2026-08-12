import { test, expect, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";

/**
 * Idle-pause / resume round-trip (issue #333), against the same mock-LLM
 * overlay as chat.spec.ts but with SESSION_IDLE_PAUSE_SECS=10 (set by
 * `scripts/e2e-local.sh pause`):
 *
 *   1. chat round-trip (container running)
 *   2. close the tab (WS gone) → within ~pause-window + 30s sweep tick the
 *      SESSION container must be docker-PAUSED
 *   3. reopen the chat → resume unpauses it; send another message → reply
 *
 * Playwright specs run on the HOST, so we can interrogate docker directly to
 * assert the real container state — the whole point of the feature.
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

function docker(...args: string[]): string {
  try {
    return execFileSync("docker", args, { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** docker state of the session's container: "running" | "paused" | "" (gone). */
function sessionContainerState(sessionId: string): string {
  const id = docker(
    "ps", "-aq",
    "--filter", `label=vonzio-session-id=${sessionId}`,
  );
  if (!id) return "";
  return docker("inspect", "--format", "{{.State.Status}}", id.split("\n")[0]);
}

test.describe.serial("idle-pause / resume round-trip (#333)", () => {
  test.skip(
    !process.env.VONZIO_E2E_PAUSE,
    "pause E2E needs the mock overlay + SESSION_IDLE_PAUSE_SECS=10 — run via `make e2e-pause`"
  );

  let page: Page;
  let sessionId: string;

  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
  });
  test.afterAll(async () => {
    await page.close().catch(() => {});
  });

  // Cold agent spawn + a >40s deliberate idle wait + resume round-trip.
  test.setTimeout(420_000);

  test("chat, idle-pause on disconnect, resume on return", async ({ browser }) => {
    // ── 1. Same setup as chat.spec.ts: admin, login, mock-backed profile ──
    const setup = await page.request.post("/api/setup", { data: ADMIN, failOnStatusCode: false });
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
    // persistent_sessions=false: profiles default to persistent (workstation)
    // sessions, which pause on WORKSTATION_IDLE_PAUSE_SECS (24h) — this spec
    // exercises the #333 fast path for NON-persistent chats.
    const patch = await page.request.patch(`/v1/profiles/${pid}`, {
      data: { model: MOCK_MODEL, persistent_sessions: false },
    });
    expect(patch.ok(), `set-model failed: ${patch.status()}`).toBeTruthy();

    // ── 2. First round-trip: send a message, get the canned reply ──
    await page.goto("/");
    const input = page.getByPlaceholder(/message vonzio/i);
    await expect(input, "chat composer should be visible").toBeVisible({ timeout: 20_000 });
    await expect(async () => {
      await input.fill("ping");
      await input.press("Enter");
      await expect(page).toHaveURL(/\/w\//, { timeout: 5_000 });
    }).toPass({ timeout: 45_000 });
    await expect(page.getByText(MOCK_REPLY).first()).toBeVisible({ timeout: 180_000 });

    sessionId = page.url().split("/w/")[1].split(/[/?#]/)[0];
    expect(sessionId, "workspace/session id from URL").toBeTruthy();
    expect(sessionContainerState(sessionId)).toBe("running");

    // ── 3. Leave: close the page so the WS drops, then wait for the sweep ──
    // (SESSION_IDLE_PAUSE_SECS=10 + 30s sweep cadence → paused well under 90s)
    await page.close();
    await expect
      .poll(() => sessionContainerState(sessionId), {
        message: "session container should be docker-paused after idle",
        timeout: 120_000,
        intervals: [5_000],
      })
      .toBe("paused");

    // ── 4. Come back: reopening the chat must resume it seamlessly ──
    page = await browser.newPage();
    await page.goto("/login");
    await page.locator('input[type="email"]').fill(ADMIN.email);
    await page.locator('input[type="password"]').fill(ADMIN.password);
    await page.getByRole("button", { name: /sign in/i }).click();
    await expect(page).not.toHaveURL(/\/login/);

    await page.goto(`/w/${sessionId}`);
    // session.resume → resumeIfPaused unpauses the container.
    await expect
      .poll(() => sessionContainerState(sessionId), {
        message: "reopening the chat should unpause the container",
        timeout: 60_000,
        intervals: [2_000],
      })
      .toBe("running");

    // ── 5. Second round-trip on the resumed container ──
    const input2 = page.getByPlaceholder(/message vonzio/i);
    await expect(input2).toBeVisible({ timeout: 20_000 });
    await input2.fill("ping again");
    await input2.press("Enter");
    // Two canned replies now — the resumed turn produced a fresh one.
    await expect(page.getByText(MOCK_REPLY).nth(1)).toBeVisible({ timeout: 180_000 });
    expect(sessionContainerState(sessionId)).toBe("running");
  });
});
