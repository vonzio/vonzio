import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end smoke suite — drives a real browser against the dockerized OSS
 * stack (dashboard :5173 + API :3000). It exists to catch the one class of
 * regression nothing else does: "first-run is broken" (the /setup wizard,
 * login, and onboarding hand-off that a brand-new self-hoster hits first).
 *
 * It assumes a FRESH stack is already running:
 *   make docker-dev-oss        # OSS mode, fresh DB → first visit routes to /setup
 * or, in CI, the e2e workflow boots one. The suite never resets data itself,
 * so it must run against an empty database (the /setup wizard 409s once an
 * admin exists). Point it elsewhere with VONZIO_E2E_BASE_URL.
 *
 * Scope is deliberately tiny: E2E is the most expensive + flakiest test tier,
 * so it guards only the critical path. Breadth lives in the unit suites.
 */
export default defineConfig({
  testDir: "./tests",
  // The first-run flow is inherently sequential (setup → login → onboarding
  // against one shared DB), so workers don't help and would race on /setup.
  fullyParallel: false,
  workers: 1,
  // Never let a half-written .only sneak a partial run through CI.
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env.CI
    ? [["list"], ["html", { open: "never" }]]
    : [["list"]],
  use: {
    baseURL: process.env.VONZIO_E2E_BASE_URL ?? "http://localhost:5173",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
