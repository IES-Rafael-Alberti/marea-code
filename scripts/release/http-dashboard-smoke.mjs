/* global window, crypto */
import assert from "node:assert/strict";
import process from "node:process";
import { createRequire } from "node:module";
import { URL } from "node:url";

async function signIn(page, origin, password) {
  await page.goto(`${origin}/dashboard/`);
  await page.locator('input[name="username"]').fill("teacher");
  await page.locator('input[name="password"]').fill(password);
  const loggedIn = page.waitForResponse((response) => response.url().endsWith("/session/login"));
  await page.locator('button[type="submit"]').click();
  assert.equal((await loggedIn).status(), 200);
  await page.locator(".session-bar button").waitFor({ state: "attached" });
  await page.locator('input[name="username"]').waitFor({ state: "detached" });
}

async function installationPanel(page) {
  await page
    .locator(".workspace-navigation button")
    .filter({ hasText: /^(Settings|Ajustes|Ezarpenak)$/u })
    .click();
  await page
    .locator(".settings-navigation button")
    .filter({ hasText: /^(Server|Servidor|Zerbitzaria)$/u })
    .click();
  await page
    .locator(".server-settings .settings-subnavigation button")
    .filter({ hasText: /^(Network and installation|Red e instalación|Sarea eta instalazioa)$/u })
    .click();
  const panel = page.locator(".preview-install");
  await panel.locator("select").waitFor();
  return panel;
}

async function assertCommands(panel, origin) {
  assert.equal(await panel.locator("select").inputValue(), origin);
  assert.ok((await panel.locator("textarea").nth(0).inputValue()).includes(`--server '${origin}'`));
  assert.ok((await panel.locator("textarea").nth(1).inputValue()).includes(`-Server '${origin}'`));
}

/** Uses the built dashboard and real server on a non-loopback HTTP origin. */
export async function verifyHttpDashboard(origin, password) {
  const { chromium } = createRequire(process.env.PLAYWRIGHT_PACKAGE)("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ locale: "en-US" });
    await page.addInitScript(() => {
      Reflect.deleteProperty(globalThis.URL, "parse");
    });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await signIn(page, origin, password);
    assert.equal(await page.evaluate(() => typeof globalThis.URL.parse), "undefined");
    assert.equal(await page.evaluate(() => window.isSecureContext), false);
    assert.equal(await page.evaluate(() => typeof crypto.randomUUID), "undefined");
    const cookies = await page.context().cookies();
    assert.ok(cookies.some((cookie) => cookie.httpOnly && !cookie.secure));
    await page.reload();
    await page.locator(".session-bar button").waitFor({ state: "attached" });
    await assertCommands(await installationPanel(page), origin);
    await signIn(page, `http://localhost:${new URL(origin).port}`, password);
    const local = await installationPanel(page);
    const choices = await local
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value));
    assert.ok(choices.includes(origin));
    assert.ok(choices.every((choice) => !/localhost|127\.0\.0\.1|0\.0\.0\.0/u.test(choice)));
    await local.locator("select").selectOption(origin);
    await assertCommands(local, origin);
    assert.deepEqual(errors, []);
    process.stdout.write(
      "Real browser HTTP login, cookie persistence and LAN installation commands from localhost passed.\n",
    );
  } finally {
    await browser.close();
  }
}
