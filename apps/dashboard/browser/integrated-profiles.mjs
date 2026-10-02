/* global console, document, getComputedStyle, fetch, crypto */
import assert from "node:assert/strict";
import { releaseProfileHttp } from "./release-profile-http.mjs";
import { releaseBrowserChecks, sessionsModule } from "./release-browser-checks.mjs";
import { once } from "node:events";
import { classSelection, openSettings, signOut } from "./workspace-navigation.mjs";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
const browser = await launchReleaseBrowser();
const url = "http://127.0.0.1:5196";
const errors = [];
const start = startReleaseHost;
const stop = stopReleaseHost;
async function teacher(login = "teacher") {
  const context = await browser.newContext({ locale: "en" });
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${url}/dashboard/`);
  await page.getByLabel("Username", { exact: true }).fill(login);
  await page.getByLabel("Password", { exact: true }).fill("teacher-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  const classRead = page.waitForResponse(
    (response) =>
      response.url().endsWith("/profiles/read") &&
      response.request().postDataJSON().scope.kind === "class",
  );
  await classSelection(page).selectOption("class:ready");
  await classRead;
  await page.waitForFunction(() => !document.querySelector(".workspace-class select")?.disabled);
  try {
    await page.locator(".session-workspace").waitFor();
  } catch (error) {
    console.error(await page.locator("body").innerText());
    console.error(errors);
    console.error(
      await post(page, "profiles/read", {
        kind: "dashboard-profile-read",
        scope: { kind: "class", classId: "class:ready" },
      }),
    );
    throw error;
  }
  return { context, page };
}
async function post(page, operation, fields) {
  return page.evaluate(
    async ({ operation, fields }) => {
      const response = await fetch(`/api/v1/dashboard/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocolVersion: "0.1",
          requestId: `browser:${crypto.randomUUID()}`,
          ...fields,
        }),
      });
      return { status: response.status, body: await response.json() };
    },
    { operation, fields },
  );
}
try {
  let host = await start(false);
  try {
    const first = await teacher();
    const editor = first.page.locator(".profile-editor");
    await openSettings(first.page);
    await editor.locator("summary").click();
    await releaseBrowserChecks(first.page, editor);
    await openSettings(first.page);
    await editor.locator('input[type="checkbox"]').nth(0).uncheck();
    await editor.locator("select").first().selectOption("org.marea.theme.high-contrast");
    const saved = first.page.waitForResponse(
      (r) => r.url().endsWith("/profiles/save") && r.status() === 200,
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await saved;
    // Forward exactly one save to the real host, then lose only its response.
    let writes = 0;
    let readbacks = 0;
    first.page.on("request", (request) => {
      if (request.url().endsWith("/profiles/read")) readbacks++;
    });
    await first.page.route("**/profiles/save", async (route) => {
      writes++;
      const response = await route.fetch({ maxRetries: 0 });
      assert.equal(response.status(), 200);
      await route.abort("failed");
    });
    await editor.locator("select").first().selectOption("org.marea.theme.marea");
    const beforeReadback = readbacks;
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor.getByRole("button", { name: "Accept current state", exact: true }).waitFor();
    assert.equal(writes, 1);
    assert.ok(readbacks > beforeReadback);
    const durable = await post(first.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope: { kind: "class", classId: "class:ready" },
    });
    assert.equal(durable.body.override.value.themeId, "org.marea.theme.marea");
    await editor.getByRole("button", { name: "Accept current state", exact: true }).click();
    await first.page.waitForTimeout(2300);
    assert.equal(writes, 1, "readback/reconciliation must never replay the save");
    await first.page.unroute("**/profiles/save");
    await editor.locator("select").first().selectOption("org.marea.theme.high-contrast");
    const restored = first.page.waitForResponse(
      (r) => r.url().endsWith("/profiles/save") && r.status() === 200,
    );
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await restored;
    const personalScope = { kind: "teacher" };
    const personalBefore = await post(first.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope: personalScope,
    });
    const personalSaved = await post(first.page, "profiles/save", {
      kind: "dashboard-profile-save",
      scope: personalScope,
      expectedRevision: personalBefore.body.personal.revision,
      expectedPersonalRevision: personalBefore.body.personal.revision,
      catalogRevision: personalBefore.body.catalogRevision,
      discardUnavailable: false,
      value: personalBefore.body.effective,
    });
    assert.equal(personalSaved.status, 200);
    const restarted = once(host.stdout, "data");
    host.kill("SIGUSR2");
    assert.match(String((await restarted)[0]), /restarted/);
    const secondBrowser = await teacher();
    const personalAfter = await post(secondBrowser.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope: personalScope,
    });
    assert.deepEqual(personalAfter.body.personal, personalSaved.body.personal);

    await secondBrowser.page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim() ===
        "#000000",
    );
    const other = await teacher("second");
    const scope = { kind: "class", classId: "class:ready" };
    const independent = await post(other.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope,
    });
    assert.equal(independent.status, 200);
    assert.equal(independent.body.override.value, null);
    assert.equal(independent.body.effective.themeId, "org.marea.theme.marea");
    const before = await post(secondBrowser.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope,
    });
    const write = {
      kind: "dashboard-profile-save",
      scope,
      expectedRevision: before.body.override.revision,
      expectedPersonalRevision: before.body.personal.revision,
      catalogRevision: before.body.catalogRevision,
      discardUnavailable: false,
      value: { themeId: "org.marea.theme.marea" },
    };
    assert.equal((await post(secondBrowser.page, "profiles/save", write)).status, 200);
    assert.equal((await post(secondBrowser.page, "profiles/save", write)).status, 409);
    await editor.locator('input[type="checkbox"]').nth(1).uncheck();
    await sessionsModule(editor).locator("select").first().selectOption("aside");
    await editor.getByRole("button", { name: "Save", exact: true }).click();
    await editor
      .getByRole("button", { name: "Keep draft against current revision", exact: true })
      .waitFor();
    assert.equal(await sessionsModule(editor).locator("select").first().inputValue(), "aside");
    const forbidden = await post(other.page, "profiles/read", {
      kind: "dashboard-profile-read",
      scope: { kind: "class", classId: "class:foreign" },
    });
    assert.equal(forbidden.status, 403);
    await releaseProfileHttp(other.page, post);
    const preview = await post(first.page, "telemetry/preview", {
      kind: "telemetry-preview",
      classId: "class:ready",
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.synthetic, true);
    assert.equal(preview.body.enabled, false);
    assert.equal(preview.body.destinationCount, 0);
    await first.page.screenshot({ path: "/tmp/profiles-integrated-dashboard.png", fullPage: true });
    const catalogChanged = once(host.stdout, "data");
    host.kill("SIGUSR1");
    assert.match(String((await catalogChanged)[0]), /catalog-changed/);
    await editor.getByRole("button", { name: "Read current state", exact: true }).click();
    await editor
      .getByText(
        "This page uses a different plugin release. Your draft is retained. Reload the page after recording your draft.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await sessionsModule(editor).locator("select").first().inputValue(), "aside");
    assert.equal(
      await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(),
      true,
    );
    let signedOutQueries = 0;
    first.page.on("request", (request) => {
      if (request.url().endsWith("/history/classes")) signedOutQueries++;
    });
    await signOut(first.page);
    await first.page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
    const stoppedAtSignOut = signedOutQueries;
    await first.page.waitForTimeout(2300);
    assert.equal(signedOutQueries, stoppedAtSignOut);
    assert.equal(await first.page.locator(".profile-shell").count(), 0);
    for (const item of [first, secondBrowser, other]) await item.context.close();
    console.log(
      "Schema 10 compiled host: real profile browser save, cross-browser persistence, independent teachers, conflicts and disabled telemetry passed.",
    );
  } finally {
    await stop(host);
  }
  host = await start(true);
  try {
    const legacy = await teacher();
    await openSettings(legacy.page);
    await legacy.page
      .getByText(
        "Dashboard customization requires an offline server upgrade. Sessions remain available.",
        { exact: true },
      )
      .waitFor();
    assert.equal(await legacy.page.locator(".profile-editor").count(), 0);
    assert.equal(await legacy.page.locator(".session-workspace").count(), 1);
    await legacy.context.close();
    console.log(
      "Schema 9 compiled host: legacy session workspace remains usable without migrating storage.",
    );
  } finally {
    await stop(host);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
