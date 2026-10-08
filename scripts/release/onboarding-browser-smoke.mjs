import assert from "node:assert/strict";
import { launchReleaseBrowser } from "../../apps/dashboard/browser/release-browser-runtime.mjs";
import { openSettings } from "../../apps/dashboard/browser/workspace-navigation.mjs";

/** Complete the real wizard and its authenticated redirect without the newer URL.parse API. */
export async function finishSetupInBrowser(url, input) {
  const browser = await launchReleaseBrowser();
  try {
    const page = await browser.newPage({ locale: "en-GB" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Reflect.deleteProperty(globalThis.URL, "parse");
    });
    await page.goto(url);
    assert.equal(await page.evaluate(() => typeof globalThis.URL.parse), "undefined");
    for (const [label, value] of [
      ["School name", input.center],
      ["First class", input.classroom],
      ["Your name", input.teacher],
      ["Dashboard username", input.login],
      ["Password", input.password],
      ["Repeat the password", input.password],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    const next = () => page.getByRole("button", { name: "Continue", exact: true }).click();
    await next();
    await page
      .getByLabel("API key", { exact: true })
      .fill(input.connections[input.route.providerId].apiKey);
    await page.locator(".server-settings select").first().selectOption(input.route.providerId);
    await page.locator("datalist option").first().waitFor({ state: "attached" });
    await page.locator(".server-settings input[list]").first().fill(input.route.model);
    await next();
    await page.getByLabel("Server port", { exact: true }).fill(String(input.port));
    await page.getByLabel("The classroom local network (HTTP)", { exact: true }).check();
    await page
      .getByLabel("Enable the example skill for learning to write tests (optional)", {
        exact: true,
      })
      .setChecked(input.testingSkill);
    await next();
    const finishing = page.waitForResponse(
      (response) =>
        response.url().endsWith("/setup/api") &&
        response.request().postDataJSON().operation === "finish",
      { timeout: 120000 },
    );
    await page
      .getByRole("button", { name: "Create school and open dashboard", exact: true })
      .click();
    const response = await finishing;
    assert.equal(response.status(), 200);
    const cookie = await response.headerValue("set-cookie");
    await page.waitForURL(`http://127.0.0.1:${input.port}/dashboard/`);
    const completed = { dashboardUrl: page.url() };
    await page.locator(".workspace-navigation").waitFor();
    assert.equal(await page.locator('input[name="username"]').count(), 0);
    await openSettings(page, "server");
    const panel = page.locator(".preview-install");
    await panel.waitFor();
    const addresses = await panel
      .locator("option")
      .evaluateAll((options) => options.map((option) => option.value).filter(Boolean));
    assert.ok(addresses.length > 0);
    await panel.locator("select").selectOption(addresses[0]);
    assert.ok(
      (await panel.locator("textarea").first().inputValue()).includes(`--server '${addresses[0]}'`),
    );
    await page.reload();
    await page.locator(".workspace-navigation").waitFor();
    await openSettings(page, "server");
    await page.locator(".preview-install").waitFor();
    assert.equal(await page.evaluate(() => typeof globalThis.URL.parse), "undefined");
    assert.deepEqual(errors, []);
    return { completed, cookie };
  } finally {
    await browser.close();
  }
}
