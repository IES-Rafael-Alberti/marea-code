/* global window, crypto */
import assert from "node:assert/strict";
import process from "node:process";
import { createRequire } from "node:module";

/** Uses the built dashboard and real server on a non-loopback HTTP origin. */
export async function verifyHttpDashboard(origin, password) {
  const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE)("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${origin}/dashboard/`);
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
    await page.locator('input[name="username"]').fill("teacher");
    await page.locator('input[name="password"]').fill(password);
    const loggedIn = page.waitForResponse((response) => response.url().endsWith("/session/login"));
    await page.locator('button[type="submit"]').click();
    assert.equal((await loggedIn).status(), 200);
    await page.locator(".session-bar button").waitFor({ state: "attached" });
    await page.locator('input[name="username"]').waitFor({ state: "detached" });
    const cookies = await page.context().cookies();
    assert.ok(cookies.some((cookie) => cookie.httpOnly && !cookie.secure));
    await page.reload();
    await page.locator(".session-bar button").waitFor({ state: "attached" });
    assert.deepEqual(errors, []);
    process.stdout.write("Real browser HTTP login and cookie persistence passed.\n");
  } finally {
    await browser.close();
  }
}
