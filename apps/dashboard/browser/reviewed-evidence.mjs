/* global document, getComputedStyle, process */
import assert from "node:assert/strict";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
import { sessionsModule, selectReleaseTheme } from "./release-browser-checks.mjs";
import { classSelection, openSettings, openView } from "./workspace-navigation.mjs";
const browser = await launchReleaseBrowser();
const host = await startReleaseHost(false, ["--evidence"]);
const errors = [];
const labels = {
  en: {
    title: "Reviewed evidence",
    history: "View evidence history",
    more: "Next page",
    refresh: "Refresh from the first page",
    open: "Open source session",
  },
  es: {
    title: "Evidencias revisadas",
    history: "Ver historial de evidencias",
    more: "Página siguiente",
    refresh: "Actualizar desde la primera página",
    open: "Abrir sesión de origen",
  },
  eu: {
    title: "Berrikusitako ebidentziak",
    history: "Ikusi ebidentzien historia",
    more: "Hurrengo orrialdea",
    refresh: "Eguneratu lehen orrialdetik",
    open: "Ireki jatorrizko saioa",
  },
};
async function waitRead(page, kind, action) {
  const [body] = await Promise.all([
    page
      .waitForResponse((r) => r.url().endsWith(`/reviewed-evidence/${kind}`))
      .then(async (response) => {
        assert.equal(response.status(), 200);
        return response.json();
      }),
    action(),
  ]);
  assert.ok(!JSON.stringify(body).match(/PRIVATE|teacherNote|studentFeedback|providerRoute/));
  return body;
}
async function evaluationDraft(page, editor, evidence) {
  await page
    .locator(".session-list li")
    .filter({ hasText: "Evidence draft" })
    .getByRole("button")
    .click();
  const evaluationRead = page.waitForResponse((r) => r.url().endsWith("/evaluations/query"));
  await page
    .locator(".detail-tabs")
    .getByRole("button", { name: "Evaluation", exact: true })
    .click();
  const evaluationResponse = await evaluationRead;
  assert.equal(evaluationResponse.status(), 200);
  assert.equal((await evaluationResponse.json()).evaluation.state, "draft");
  // Drafts stay mounted in the hidden Sessions view while Settings and Progress are open.
  const feedback = page.getByRole("textbox", {
    name: "Feedback sent to the student",
    exact: true,
    includeHidden: true,
  });
  const note = page.getByRole("textbox", {
    name: "Private teacher note",
    exact: true,
    includeHidden: true,
  });
  await feedback.fill("Reviewed edited feedback");
  await note.fill("PRIVATE EDITED NOTE");
  await openSettings(page);
  await editor.locator('input[type="checkbox"]').nth(0).uncheck();
  for (const theme of ["org.marea.theme.high-contrast", "org.marea.theme.marea"]) {
    await selectReleaseTheme(page, editor, theme);
    assert.equal(await feedback.inputValue(), "Reviewed edited feedback");
    assert.equal(await note.inputValue(), "PRIVATE EDITED NOTE");
  }
  await sessionsModule(editor).locator("select").first().selectOption("aside");
  assert.equal(await feedback.inputValue(), "Reviewed edited feedback");
  await openView(page, "progress");
  page.once("dialog", (dialog) => dialog.dismiss());
  await evidence.getByRole("button", { name: labels.en.open, exact: true }).first().click();
  await evidence.getByRole("alert").waitFor();
  assert.equal(await feedback.inputValue(), "Reviewed edited feedback");
  const selection = classSelection(page);
  page.once("dialog", (dialog) => dialog.dismiss());
  await selection.selectOption("class:other");
  assert.equal(await selection.inputValue(), "class:ready");
  assert.equal(await feedback.inputValue(), "Reviewed edited feedback");
  // Only this explicit click may publish the reviewed feedback.
  await openView(page, "sessions");
  const approved = page.waitForResponse(
    (r) => r.url().endsWith("/evaluations/approve") && r.status() === 200,
  );
  await page.getByRole("button", { name: "Approve and send feedback", exact: true }).click();
  const record = (await (await approved).json()).evaluation;
  assert.equal(record.state, "approved");
  assert.equal(record.draft.studentFeedback, "Reviewed edited feedback");
  assert.equal(record.draft.teacherNote, "PRIVATE EDITED NOTE");
  await feedback.waitFor({ state: "visible" });
  assert.equal(await feedback.isDisabled(), true);
  await selection.selectOption("class:other");
  assert.equal(await selection.inputValue(), "class:other");
}
try {
  for (const locale of ["es", "eu", "en"]) {
    const context = await browser.newContext({ locale: "en" });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://127.0.0.1:5196/dashboard/");
    await page.getByLabel("Username", { exact: true }).fill("teacher");
    await page.getByLabel("Password", { exact: true }).fill("teacher-password");
    await page.locator(".interface-language select").selectOption(locale);
    await page.locator(".session-form button[type=submit]").click();
    const profile = page.waitForResponse(
      (r) =>
        r.url().endsWith("/profiles/read") && r.request().postDataJSON().scope.kind === "class",
    );
    await classSelection(page).selectOption("class:ready");
    await profile;
    const editor = page.locator(".profile-editor");
    await openSettings(page);
    await editor.locator("summary").click();
    const m = labels[locale];
    const evidence = page.getByRole("region", { name: m.title, exact: true });
    assert.equal(await evidence.count(), 0, "optional module is initially disabled");
    await editor.locator('input[type="checkbox"]').nth(1).uncheck();
    const descriptor = editor
      .locator("li > fieldset")
      .filter({ has: page.locator("legend").getByText(m.title, { exact: true }) });
    const students = await waitRead(page, "students", () =>
      descriptor.locator('input[type="checkbox"]').check(),
    );
    assert.equal(students.entries.length, 2, "homonymous students keep separate IDs");
    // Reviewed evidence is learning evidence, shown with Progress.
    await openView(page, "progress");
    const criteria = await waitRead(page, "criteria", () =>
      evidence
        .getByRole("button", { name: "Synthetic student · student:release", exact: true })
        .click(),
    );
    assert.equal(new Set(criteria.entries.map((row) => row.digest)).size, 2);
    const selected = evidence.locator("li").filter({ hasText: "Frozen boundary one" });
    const history = await waitRead(page, "history", () =>
      selected.getByRole("button", { name: m.history, exact: true }).click(),
    );
    assert.equal(history.entries.length, 25);
    assert.ok(history.next);
    const older = await waitRead(page, "history", () =>
      evidence.getByRole("button", { name: m.more, exact: true }).click(),
    );
    assert.equal(older.entries.length, 1);
    assert.equal(older.next, null);
    assert.equal(
      new Set([...history.entries, ...older.entries].map((row) => row.evaluationId)).size,
      26,
    );
    await waitRead(page, "history", () =>
      evidence.getByRole("button", { name: m.refresh, exact: true }).click(),
    );
    await evidence.locator("ol > li").first().waitFor();
    await evidence.getByRole("heading", { name: m.title, exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.MAREA_SCREENSHOTS ?? "/tmp"}/reviewed-evidence-${locale}.png`,
    });
    await page.setViewportSize({ width: 360, height: 800 });
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    await page.keyboard.press("Tab");
    const refresh = evidence.getByRole("button", { name: m.refresh, exact: true });
    await refresh.focus();
    assert.notEqual(await refresh.evaluate((el) => getComputedStyle(el).outlineStyle), "none");
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    );
    await evidence.getByRole("heading", { name: m.title, exact: true }).scrollIntoViewIfNeeded();
    await page.screenshot({
      path: `${process.env.MAREA_SCREENSHOTS ?? "/tmp"}/reviewed-evidence-${locale}-narrow.png`,
    });
    await page.emulateMedia({ forcedColors: "none", reducedMotion: "no-preference" });
    await page.setViewportSize({ width: 1280, height: 900 });
    await evidence.getByRole("button", { name: m.open, exact: true }).first().click();
    await page.locator('.session-list button[aria-current="true"]').waitFor();
    assert.ok(
      (
        await page.locator('.session-list button[aria-current="true"]').locator("..").innerText()
      ).includes("Evidence v1"),
    );
    if (locale === "en") await evaluationDraft(page, editor, evidence);
    await context.close();
  }
  assert.deepEqual(errors, []);
} finally {
  await stopReleaseHost(host);
  await browser.close();
}
