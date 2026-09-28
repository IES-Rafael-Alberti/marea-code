/* global document, getComputedStyle */
import assert from "node:assert/strict";

/** The sessions entry of the composition editor, independent of catalog order. */
export function sessionsModule(editor) {
  return editor.locator("li > fieldset").filter({
    has: editor
      .page()
      .locator("legend")
      .getByText(/^(Sessions and evaluation|Sesiones y evaluación|Saioak eta ebaluazioa)$/),
  });
}

export async function releaseBrowserChecks(page, editor) {
  const sessions = sessionsModule(editor);
  await page.locator(".session-list li button").first().click();
  const notice = page.locator(".notice-composer textarea");
  await notice.fill("Synthetic unsent notice");
  const selected = page.locator('.session-list button[aria-current="true"]');
  await editor.locator('input[type="checkbox"]').nth(0).uncheck();
  for (const theme of ["org.marea.theme.high-contrast", "org.marea.theme.marea"]) {
    await selectReleaseTheme(page, editor, theme);
    await page.screenshot({
      path: `/tmp/p4-release-normal-${theme.split(".").at(-1)}.png`,
      fullPage: true,
    });
    assert.equal(await notice.inputValue(), "Synthetic unsent notice");
    assert.equal(await selected.count(), 1);
    const save = editor.getByRole("button", { name: "Save", exact: true });
    await page.keyboard.press("Tab");
    await save.focus();
    assert.notEqual(await save.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    await page.setViewportSize({ width: 360, height: 800 });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "200%";
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      `${theme}: 200% zoom reflows`,
    );
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.keyboard.press("Tab");
    await save.focus();
    assert.notEqual(await save.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    assert.equal(await save.evaluate((el) => getComputedStyle(el).animationName), "none");
    await page.screenshot({
      path: `/tmp/p4-release-${theme.split(".").at(-1)}.png`,
      fullPage: true,
    });
    await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
    await page.evaluate(() => {
      document.documentElement.style.zoom = "100%";
    });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  // Rejecting the real native navigation decision preserves session and notice.
  const selection = page.locator(".profile-shell > label select").first();
  page.once("dialog", (dialog) => dialog.dismiss());
  await selection.selectOption("");
  assert.equal(await selection.inputValue(), "class:ready");
  assert.equal(await notice.inputValue(), "Synthetic unsent notice");
  page.once("dialog", (dialog) => dialog.accept());
  await editor.locator('input[type="checkbox"]').nth(1).uncheck();
  // Layout changes preserve the mounted session even after the explicit decision.
  await sessions.locator("select").first().selectOption("aside");
  assert.equal(await notice.inputValue(), "Synthetic unsent notice");
  let queries = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/history/classes")) queries++;
  });
  page.once("dialog", (dialog) => dialog.accept());
  await sessions.locator('input[type="checkbox"]').uncheck();
  await page.locator(".session-workspace").waitFor({ state: "detached" });
  const stopped = queries;
  await page.waitForTimeout(2300);
  assert.equal(queries, stopped, "disabled module must stop polling");
  await sessions.locator('input[type="checkbox"]').check();
  await page.locator(".session-workspace").waitFor();
  await page.locator(".session-list li button").first().click();
  assert.equal(
    await notice.inputValue(),
    "",
    "disposed module must not resurrect its unsent draft",
  );
  await sessions.locator("select").first().selectOption("main");
  await editor.locator('input[type="checkbox"]').nth(1).check();
  await editor.locator('input[type="checkbox"]').nth(0).check();
  // Hold an actual old-class response across a context change; only delivery is intercepted.
  const arrived = Promise.withResolvers();
  const delayed = Promise.withResolvers();
  await page.route("**/history/classes", async (route) => {
    if (route.request().postDataJSON().classId !== "class:ready") return route.continue();
    const response = await route.fetch({ maxRetries: 0 });
    arrived.resolve();
    await delayed.promise;
    await route.fulfill({ response });
  });
  await page.locator(".session-list .actions button").first().click();
  await arrived.promise;
  await selection.selectOption("class:other");
  await page.locator(".session-workspace").waitFor();
  delayed.resolve();
  await page.waitForTimeout(2300);
  assert.equal(await page.getByText("Synthetic release project", { exact: true }).count(), 0);
  assert.equal(await selection.inputValue(), "class:other");
  await page.unroute("**/history/classes");
  await selection.selectOption("class:ready");
  // Returning to a cached dirty profile requires explicit reconciliation with its fresh read.
  await editor
    .getByRole("button", { name: "Keep draft against current revision", exact: true })
    .click();
  await page.locator(".session-list li button").first().waitFor();
}

export async function selectReleaseTheme(page, editor, theme) {
  await editor.locator("select").first().selectOption(theme);
  await page.waitForFunction(
    (expected) =>
      getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim() ===
      expected,
    theme.endsWith("high-contrast") ? "#000000" : "#101e24",
  );
}
