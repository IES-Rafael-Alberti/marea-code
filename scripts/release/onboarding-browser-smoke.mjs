import process from "node:process";
import { verifyIdentitySettings } from "./identity-settings-browser-smoke.mjs";
import { verifySettingsValidation } from "./settings-validation-browser-smoke.mjs";
import { verifySetupPasswordLayout } from "./onboarding-layout-browser-smoke.mjs";
import assert from "node:assert/strict";
import { launchReleaseBrowser } from "../../apps/dashboard/browser/release-browser-runtime.mjs";
import { openSettings } from "../../apps/dashboard/browser/workspace-navigation.mjs";
import { verifyOnboardingModules } from "./onboarding-modules-browser-smoke.mjs";

/** Complete the real wizard without APIs absent in Safari 17.1. */
export async function finishSetupInBrowser(url, input) {
  const browser = await launchReleaseBrowser();
  try {
    const page = await browser.newPage({ locale: "en-GB" });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => {
      Reflect.deleteProperty(globalThis.URL, "parse");
      Reflect.deleteProperty(globalThis.AbortSignal, "any");
      Reflect.deleteProperty(globalThis.Map, "groupBy");
      Reflect.deleteProperty(globalThis.Object, "groupBy");
      Reflect.deleteProperty(globalThis.Promise, "withResolvers");
    });
    await page.goto(url);
    if (process.env.MAREA_UX_SHOTS)
      await page.screenshot({ path: "/tmp/marea-ux-class.png", fullPage: true });
    assert.equal(await page.evaluate(() => typeof globalThis.URL.parse), "undefined");
    await verifySetupPasswordLayout(page, input.password);
    const password = page.getByLabel("Password", { exact: true });
    const repeated = page.getByLabel("Repeat the password", { exact: true });
    await password.fill("short");
    await repeated.focus();
    assert.equal(await password.getAttribute("aria-invalid"), "true");
    assert.ok(await page.locator("#setup-password-error").isVisible());
    await password.fill(input.password);
    await repeated.fill("different-password");
    await password.focus();
    assert.equal(await repeated.getAttribute("aria-invalid"), "true");
    await page.getByRole("button", { name: "Show or hide: Password", exact: true }).click();
    assert.equal(await password.getAttribute("type"), "text");
    for (const [label, value] of [
      ["School name", input.center],
      ["Name of your first class", input.classroom],
      ["Your name", input.teacher],
      ["Dashboard username", input.login],
      ["Password", input.password],
      ["Repeat the password", input.password],
    ])
      await page.getByLabel(label, { exact: true }).fill(value);
    const next = () => page.getByRole("button", { name: "Continue", exact: true }).click();
    await next();
    assert.equal(await page.getByText("Usage limits", { exact: true }).count(), 0);
    await page
      .getByLabel("API key", { exact: true })
      .fill(input.connections[input.route.providerId].apiKey);
    await page.locator("datalist option").first().waitFor({ state: "attached" });
    await page.locator(".server-settings input[list]").first().fill(input.route.model);
    if (process.env.MAREA_UX_SHOTS)
      await page.screenshot({ path: "/tmp/marea-ux-model.png", fullPage: true });
    await next();
    await page.getByText("Connection options", { exact: true }).click();
    await page.getByLabel("Server port", { exact: true }).fill(String(input.port));
    await page.getByLabel("The classroom local network (HTTP)", { exact: true }).check();
    await next();
    await page
      .getByLabel("Example skill: learning to write tests", {
        exact: true,
      })
      .setChecked(input.testingSkill);
    for (const [key, label] of [
      ["map", "Attention map"],
      ["reports", "Class reports"],
      ["automaticEvaluation", "Automatic evaluation"],
    ])
      await page.getByLabel(label, { exact: true }).setChecked(input.features?.[key] === true);
    await next();
    if (process.env.MAREA_UX_SHOTS)
      await page.screenshot({ path: "/tmp/marea-ux-review.png", fullPage: true });
    const finishing = page.waitForResponse(
      (response) =>
        response.url().endsWith("/setup/api") &&
        response.request().postDataJSON().operation === "finish",
      { timeout: 120000 },
    );
    await page.getByRole("button", { name: "Open my class", exact: true }).click();
    const response = await finishing;
    assert.equal(response.status(), 200);
    const cookie = await response.headerValue("set-cookie");
    await page.waitForURL(`http://127.0.0.1:${input.port}/dashboard/?class=class%3Amain&welcome=1`);
    const completed = { dashboardUrl: page.url() };
    await page.locator(".workspace-navigation").waitFor();
    assert.equal(await page.locator('input[name="username"]').count(), 0);
    await verifyOnboardingModules(page, input.classroom);
    if (process.env.MAREA_UX_SHOTS)
      await page.screenshot({ path: "/tmp/marea-ux-dashboard.png", fullPage: true });
    await openSettings(page, "server");
    await page.getByRole("button", { name: "Network and installation", exact: true }).click();
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
    await verifyOnboardingModules(page, input.classroom);
    await openSettings(page, "server");
    await page.getByRole("button", { name: "Network and installation", exact: true }).click();
    await page.locator(".preview-install").waitFor();
    assert.equal(await page.evaluate(() => typeof globalThis.URL.parse), "undefined");
    await verifyIdentitySettings(page);
    await verifySettingsValidation(page);
    assert.deepEqual(errors, []);
    return { completed, cookie };
  } finally {
    await browser.close();
  }
}
