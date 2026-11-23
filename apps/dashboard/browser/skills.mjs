/* global console, document, URL */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
import { openView, openSettings, classSelection } from "./workspace-navigation.mjs";

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
  await page.goto("http://127.0.0.1:5198/");
  assert.equal(new URL(page.url()).pathname, "/dashboard/");
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
  assert.equal(await button(workspace, "Create a skill").count(), 0);
  await button(workspace, "Choose skills from library").click();
  const dialog = workspace.locator("dialog");
  await dialog.waitFor();
  await dialog.getByRole("combobox", { name: "Module", exact: true }).selectOption("code:0485");
  await dialog.getByRole("searchbox").fill("RA3.f");
  const testing = dialog.getByRole("checkbox", { name: /testing/u });
  await testing.waitFor();
  assert.ok(
    (await dialog.locator(".skills-curriculum").innerText()).includes(
      "Programación · 0485 · RA3.f",
    ),
  );
  const position = await testing.boundingBox();
  await testing.check();
  assert.ok(Math.abs((await testing.boundingBox()).y - position.y) < 1);
  await page.screenshot({ path: join(artifacts, "selection.png"), fullPage: true });
  await button(dialog, "Save selection").click();
  await saved();
  await tab("By student");
  const student = (name) =>
    workspace.locator(".skills-students li").filter({ has: page.getByText(name, { exact: true }) });
  await button(student("Ana"), "Customize skills").click();
  await testing.uncheck();
  await button(dialog, "Save selection").click();
  await saved();
  await student("Ana").getByText("No didactic skills", { exact: true }).waitFor();
  assert.ok((await student("Pablo").innerText()).includes("From the class"));
  for (const name of ["Ana", "Pablo"])
    await workspace.getByRole("checkbox", { name, exact: true }).check();
  await button(workspace, "Customize skills for selected students (2)").click();
  assert.equal(await testing.isChecked(), true);
  await button(dialog, "Save selection").click();
  await saved();
  await button(student("Ana"), "Use the class selection").click();
  await saved();
  await student("Ana").getByText("From the class", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "students.png"), fullPage: true });
  await tab("Library");
  await button(workspace, "Create a skill").waitFor();
  const librarySource = workspace.getByRole("combobox", { name: "Library", exact: true });
  await librarySource.selectOption("marea");
  await workspace.locator(".skills-open").filter({ hasText: "testing" }).click();
  await button(workspace.locator(".skills-detail"), "Create my version").click();
  const editor = workspace.locator(".skills-editor");
  const markdown = editor.getByRole("textbox", { name: "SKILL.md", exact: true });
  const copied = await markdown.inputValue();
  const name = /^name: (.+)$/mu.exec(copied)[1];
  await markdown.fill(
    `---\nname: ${name}\ndescription: Practice one focused test at a time.\nmetadata:\n  title: Testing foundations\ncriterios:\n  - codigo: local-1\n    enunciado: Chooses a useful test\n    niveles: [Guided, Supported, Independent, Novel]\n---\n# Practice\nAsk the learner to explain one test before writing code.`,
  );
  // A controlled model response reproduces React batching without making an external paid call.
  const beforeGeneration = await markdown.inputValue();
  const generated = beforeGeneration.replace("# Practice", "# Generated practice");
  const workspacePath = "**/api/v1/dashboard/skill-workspace";
  await page.route(workspacePath, async (route) => {
    const input = route.request().postDataJSON();
    if (input.kind !== "generate") return route.continue();
    await route.fulfill({
      json: {
        protocolVersion: input.protocolVersion,
        requestId: input.requestId,
        classId: input.classId,
        kind: "generate",
        content: generated,
      },
    });
  });
  await editor.locator(".skills-generation summary").click();
  await editor
    .getByRole("textbox", {
      name: "What should students learn, and what are your criteria?",
      exact: true,
    })
    .fill("Practice useful boundary tests");
  await button(editor, "Generate draft").click();
  await page.waitForFunction(
    (value) => document.querySelector("#skill-markdown").value === value,
    generated,
  );
  assert.equal(await editor.locator("pre").count(), 0);
  await button(editor, "Undo generation").click();
  assert.equal(await markdown.inputValue(), beforeGeneration);
  await page.unroute(workspacePath);
  await page.screenshot({ path: join(artifacts, "editor.png"), fullPage: true });
  await button(editor, "Save to library").click();
  await workspace.getByText("Changes saved.", { exact: true }).waitFor();
  await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).waitFor();
  assert.equal(await librarySource.inputValue(), "all");
  await tab("This class");
  await button(workspace, "Choose skills from library").click();
  await dialog.getByRole("checkbox", { name: /Testing foundations/u }).check();
  await button(dialog, "Save selection").click();
  await saved();
  await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).click();
  await button(workspace.locator(".skills-detail"), "Edit").click();
  await markdown.fill(
    (await markdown.inputValue()).replace(
      "Ask the learner to explain one test before writing code.",
      "Ask for a normal case, an empty case and a boundary case.",
    ),
  );
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
    .getByText(/Ask for a normal case, an empty case and a boundary case./u)
    .waitFor();
  await page.screenshot({ path: join(artifacts, "library.png"), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(artifacts, "mobile-detail.png"), fullPage: true });
  assert.ok(
    (await workspace.locator(".skills-detail pre").innerText()).includes(
      "niveles: [Guided, Supported, Independent, Novel]",
    ),
  );
  await button(workspace.locator(".skills-detail"), "Delete from library").click();
  await workspace.getByRole("alertdialog").waitFor();
  await button(workspace.getByRole("alertdialog"), "Cancel").click();
  await button(workspace.locator(".skills-detail"), "Delete from library").click();
  await button(workspace.getByRole("alertdialog"), "Delete and remove from assignments").click();
  await workspace
    .getByText("Skill deleted and removed from assignments.", { exact: true })
    .waitFor();
  await page.reload();
  await page.locator(".workspace-navigation").waitFor();
  await openView(page, "skills");
  await tab("Library");
  assert.equal(
    await workspace.locator(".skills-open").filter({ hasText: "Testing foundations" }).count(),
    0,
  );
  await openSettings(page, "panel");
  const saveLanguage = page.waitForResponse(
    (response) =>
      response.url().endsWith("/profiles/language") &&
      response.request().postDataJSON().kind === "save",
  );
  await page.getByLabel("Interface language", { exact: true }).selectOption("es");
  assert.equal((await saveLanguage).status(), 200);
  await page.waitForFunction(() => document.documentElement.lang === "es");
  // A fresh browser context has neither the previous local preference nor the authentication cookie.
  const otherBrowser = await browser.newPage({ locale: "en-GB" });
  await otherBrowser.goto("http://127.0.0.1:5198/");
  await otherBrowser.locator('input[name="username"]').fill("teacher");
  await otherBrowser.locator('input[type="password"]').fill("teacher-password");
  await otherBrowser.getByRole("button", { name: "Sign in", exact: true }).click();
  await otherBrowser.locator(".workspace-navigation").waitFor();
  await otherBrowser.waitForFunction(() => document.documentElement.lang === "es");
  await openSettings(otherBrowser, "panel");
  assert.equal(
    await otherBrowser.getByLabel("Idioma de la interfaz", { exact: true }).inputValue(),
    "es",
  );
  await otherBrowser.close();
  assert.deepEqual(errors, []);
  console.log(
    "Skills browser acceptance passed: class, individual and bulk assignments, inheritance, copy, inline generation and undo, editing, root redirect and account language across browsers.",
  );
} catch (error) {
  await page.screenshot({ path: join(artifacts, "failure.png"), fullPage: true });
  console.error(await page.locator(".skills-workspace").ariaSnapshot());
  throw error;
} finally {
  await browser.close();
  await stopReleaseHost(host);
}
