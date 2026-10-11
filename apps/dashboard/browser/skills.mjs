/* global console */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
import { openView, classSelection } from "./workspace-navigation.mjs";

const artifacts = resolve("reports/skills-browser");
mkdirSync(artifacts, { recursive: true });
const host = await startReleaseHost(false);
const browser = await launchReleaseBrowser();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 }, locale: "en-GB" });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.addInitScript(() => {
    Reflect.deleteProperty(globalThis.URL, "parse");
    Reflect.deleteProperty(globalThis.AbortSignal, "any");
  });
  await page.goto("http://127.0.0.1:5198/dashboard/index.html");
  await page.locator('input[name="username"]').fill("teacher");
  await page.locator('input[type="password"]').fill("teacher-password");
  await page.getByLabel(/Idioma|Interface language/u).selectOption("en");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".workspace-navigation").waitFor();
  await classSelection(page).selectOption("class:ready");
  await openView(page, "skills");
  const workspace = page.locator(".skills-workspace");
  const button = (scope, name) => scope.getByRole("button", { name, exact: true });
  const tab = (name) => button(workspace.locator(".skills-tabs"), name).click();
  const saved = () =>
    workspace
      .getByRole("status")
      .filter({ hasText: "Selection saved for new sessions." })
      .waitFor();
  await button(workspace, "Add skills").click();
  const dialog = workspace.locator("dialog");
  await dialog.waitFor();
  const testing = dialog.getByRole("checkbox", { name: /testing/u });
  const position = await testing.boundingBox();
  await testing.check();
  assert.ok(Math.abs((await testing.boundingBox()).y - position.y) < 1);
  await page.screenshot({ path: join(artifacts, "selection.png"), fullPage: true });
  await button(dialog, "Save selection").click();
  await saved();
  await tab("By student");
  const student = (name) =>
    workspace.locator(".skills-students li").filter({ has: page.getByText(name, { exact: true }) });
  await button(student("Ana"), "Choose for this student").click();
  await testing.uncheck();
  await button(dialog, "Save selection").click();
  await saved();
  await student("Ana").getByText("No didactic skills", { exact: true }).waitFor();
  assert.ok((await student("Pablo").innerText()).includes("From the class"));
  for (const name of ["Ana", "Pablo"])
    await workspace.getByRole("checkbox", { name, exact: true }).check();
  await button(workspace, "Choose for selected students (2)").click();
  assert.equal(await testing.isChecked(), true);
  await button(dialog, "Save selection").click();
  await saved();
  await button(student("Ana"), "Use the class selection").click();
  await saved();
  await student("Ana").getByText("From the class", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "students.png"), fullPage: true });
  await tab("Library");
  const librarySource = workspace.getByRole("combobox", { name: "Library", exact: true });
  await librarySource.selectOption("marea");
  await workspace.locator(".skills-open").filter({ hasText: "testing" }).click();
  await button(workspace.locator(".skills-detail"), "Create my version").click();
  const editor = workspace.locator(".skills-editor");
  await editor.getByLabel("Name", { exact: true }).fill("Testing foundations");
  await editor
    .getByLabel("Short description", { exact: true })
    .fill("Practice one focused test at a time.");
  await editor
    .getByLabel("Tutor instructions", { exact: true })
    .fill("Ask the learner to explain one test before writing code.");
  await page.screenshot({ path: join(artifacts, "editor.png"), fullPage: true });
  await button(editor, "Save to library").click();
  await workspace.getByText("Changes saved.", { exact: true }).waitFor();
  await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).waitFor();
  assert.equal(await librarySource.inputValue(), "all");
  await tab("This class");
  await button(workspace, "Add skills").click();
  await dialog.getByRole("checkbox", { name: /Testing foundations/u }).check();
  await button(dialog, "Save selection").click();
  await saved();
  await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).click();
  await button(workspace.locator(".skills-detail"), "Edit").click();
  await editor
    .getByLabel("Tutor instructions", { exact: true })
    .fill("Ask for a normal case, an empty case and a boundary case.");
  await editor
    .getByText("Will update 1 classes and 0 individual selections.", { exact: true })
    .waitFor();
  await button(editor, "Save and apply").click();
  await workspace.getByText("Changes saved.", { exact: true }).waitFor();
  await page.reload();
  await page.locator(".workspace-navigation").waitFor();
  await openView(page, "skills");
  await tab("By student");
  await student("Ana")
    .getByText(/Testing foundations/u)
    .waitFor();
  assert.ok(!(await student("Pablo").innerText()).includes("Testing foundations"));
  await tab("Library");
  await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).click();
  await workspace
    .locator(".skills-detail")
    .getByText("Ask for a normal case, an empty case and a boundary case.", { exact: true })
    .waitFor();
  await page.screenshot({ path: join(artifacts, "library.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "mobile-detail.png"), fullPage: true });
  await button(workspace.locator(".skills-detail"), "Close").click();
  assert.deepEqual(errors, []);
  console.log(
    "Skills browser acceptance passed: class, individual and bulk assignments, inheritance, copy, editing and reload.",
  );
} catch (error) {
  await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
  throw error;
} finally {
  await browser.close();
  await stopReleaseHost(host);
}
