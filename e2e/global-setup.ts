import { chromium } from "@playwright/test";

/**
 * Warm the Vite dev server before the specs run.
 *
 * The dockerized stack serves the dashboard from the Vite DEV server. On a cold
 * start, the first browser load pulls in dependencies the startup scan can't
 * reach — notably the plugin frontends behind the `virtual:vonzio-plugins`
 * module (`@vonzio/dashboard-registry/api`, `qrcode.react`, …), which Vite
 * discovers only when that code actually runs. That discovery triggers a
 * dependency re-optimization and a full-page reload; the reload aborts the
 * in-flight module requests (`net::ERR_NETWORK_CHANGED`) and blanks the page.
 * When it lands inside a spec's assertion window it reads as "the /setup wizard
 * never rendered" — the flaky first-run failure that also trips unrelated PRs.
 *
 * Loading the app here absorbs that one-time optimize+reload so the specs run
 * against a warm server with a stable module graph. It only renders `/login`
 * (which boots the full app shell + registers plugin frontends without auth or
 * a fresh-DB dependency) — it never submits, so the DB stays empty for the
 * first-run suite's /setup step.
 */
export default async function globalSetup() {
  const baseURL = process.env.VONZIO_E2E_BASE_URL ?? "http://localhost:5173";
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    // First load kicks off the cold-start dep optimization; give Vite room to
    // finish it and fire its one full reload.
    await page.goto(`${baseURL}/login`, { waitUntil: "load", timeout: 30_000 }).catch(() => {});
    await page.waitForTimeout(4_000);
    // Second load runs against the now-warm optimizer: a settled network here
    // means the graph is stable and the specs won't race a reload.
    await page.goto(`${baseURL}/login`, { waitUntil: "networkidle", timeout: 30_000 }).catch(() => {});
  } finally {
    await browser.close();
  }
}
