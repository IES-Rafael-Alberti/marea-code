/* global Buffer, console, process */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import {
  AUTHORING,
  TEACHING,
  envelope,
  plainFiles,
  proofSupport,
  skillText,
} from "./teaching-acceptance-support.mjs";
import { launchAcceptanceBrowser, newDiagnosticContext } from "./browser-acceptance-context.mjs";
import { classSelection, openSettings } from "./workspace-navigation.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("playwright/test");
const baseUrl = process.env.TEACHING_ACCEPTANCE_URL;
const root = process.env.TEACHING_ACCEPTANCE_ROOT;
if (!baseUrl || !root)
  throw new Error("TEACHING_ACCEPTANCE_URL and TEACHING_ACCEPTANCE_ROOT are required");
let browser;
let page;
try {
  browser = await launchAcceptanceBrowser();
  const context = await newDiagnosticContext(browser);
  page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const p = proofSupport(context, page, root, baseUrl, expect);
  await p.login(context, "teacher1");
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  if (process.env.TEACHING_ACCEPTANCE_FAIL === "1")
    throw new Error("Intentional acceptance failure for cleanup verification");
  const hold = Number(process.env.TEACHING_ACCEPTANCE_HOLD_MS ?? "0");
  if (hold > 0) {
    console.log("TEACHING_BROWSER_READY_FOR_SIGNAL");
    await new Promise((resolve) => globalThis.setTimeout(resolve, hold));
  }
  const teaching = page.locator(".teaching-module");
  const authoring = page.locator(".skill-authoring-module");
  // Teaching and skill editing share the workspace class selector, under Settings > This class.
  await openSettings(page, "classroom");
  await page
    .locator(".settings-page:not([hidden]) details.workspace-advanced > summary")
    .first()
    .click();
  const textOf = () => authoring.getByLabel("File text", { exact: true }).first();
  const click = (module, name) => module.getByRole("button", { name, exact: true }).click();
  const authoringPosts = () => p.requests.filter(({ path }) => path.startsWith(AUTHORING));
  // Both modules intentionally use the teaching catalog/classes endpoints.
  // Configuration reads/writes belong exclusively to the teaching controller.
  const teachingPosts = () =>
    p.requests.filter(({ path }) => path === `${TEACHING}/read` || path === `${TEACHING}/save`);
  const writes = () =>
    p.requests.filter(({ path }) => path.endsWith("/save") || path.endsWith("/copy"));
  const select = async (classId) => {
    const catalog = await p.action(`${TEACHING}/catalog`, () =>
      classSelection(page).selectOption(classId),
    );
    await p.idle(teaching);
    await p.idle(authoring);
    assert.equal(catalog.classId, classId);
    assert.deepEqual(
      catalog.skills.filter(({ source }) => source === "center").map(({ id }) => id),
      [`center/center:${classId.slice("class:".length)}/core-practice`],
    );
  };
  const saveSkill = async () => {
    const response = await p.action(`${AUTHORING}/save`, () =>
      click(authoring, "Save personal skill"),
    );
    await p.idle(authoring);
    await expect(authoring.locator(".skill-authoring-content-status")).toHaveText(
      "Saved canonical content",
    );
    return response.skill;
  };
  const saveTeaching = async () => {
    const response = await p.action(`${TEACHING}/save`, () =>
      click(teaching, "Save configuration"),
    );
    await p.idle(teaching);
    await p.verifyTeaching(response.configuration, response.classId);
    return response.configuration;
  };
  const openPersonal = async (slug) => {
    await authoring.getByLabel("Personal slug", { exact: true }).fill(slug);
    await p.action(`${AUTHORING}/read`, () => click(authoring, "Create or open personal skill"));
    await p.idle(authoring);
  };
  const reloadTeaching = async () => {
    await p.action(`${TEACHING}/catalog`, () => click(teaching, "Reload current configuration"));
    await p.idle(teaching);
  };

  await expect(classSelection(page).locator("option")).toHaveCount(3);
  await select("class:one");
  assert.equal(await p.readTeaching(), null);
  await teaching
    .getByRole("textbox", { name: /^Guided mode instructions/ })
    .fill("Class one original");
  const original = await saveTeaching();
  await select("class:two");
  await teaching
    .getByRole("textbox", { name: /^Guided mode instructions/ })
    .fill("Class two original");
  const originalTwo = await saveTeaching();
  await select("class:one");

  // Create is exercised independently of copying, and validation cannot publish.
  await openPersonal("browser-journey");
  const initialFiles = [{ path: "SKILL.md", content: skillText("Created in browser") }];
  await textOf().fill(initialFiles[0].content);
  const validated = await p.action(`${AUTHORING}/validate`, () =>
    click(authoring, "Validate draft"),
  );
  await p.idle(authoring);
  assert.equal(await p.readSkill(), null);
  assert.deepEqual(plainFiles(validated.skill), initialFiles);
  const beforeCreateTeaching = teachingPosts();
  const created = await saveSkill();
  await p.verifyBundle(created, initialFiles);
  assert.deepEqual(teachingPosts(), beforeCreateTeaching);
  await p.verifyTeaching(original);

  // Core is read-only. Copy publishes a new personal identity and every resource.
  await p.action(`${AUTHORING}/read`, () =>
    authoring
      .locator(".skill-authoring-catalog-entry")
      .filter({ hasText: "marea" })
      .getByRole("button", { name: "core-practice", exact: true })
      .click(),
  );
  await p.idle(authoring);
  await expect(textOf()).toBeDisabled();
  await expect(
    authoring.getByRole("button", { name: "Save personal skill (blocked)", exact: true }),
  ).toBeDisabled();
  const core = await p.api(
    `${AUTHORING}/read`,
    envelope("skill-authoring-read", {
      classId: "class:one",
      target: { scope: "catalog", skillId: "marea/core-practice" },
    }),
  );
  await authoring.getByLabel("Destination slug").fill("browser-copy");
  const copied = await p.action(`${AUTHORING}/copy`, () =>
    click(authoring, "Copy to personal skill"),
  );
  await p.idle(authoring);
  const copiedFiles = plainFiles(core.skill).map((file) =>
    file.path === "SKILL.md"
      ? { ...file, content: file.content.replace("name: core-practice", "name: browser-copy") }
      : file,
  );
  await p.verifyBundle(copied.skill, copiedFiles);
  await p.verifyTeaching(original);
  assert.deepEqual(teachingPosts(), beforeCreateTeaching);

  // Native files replace a dirty draft only on confirmation; nested encoded names roundtrip.
  await openPersonal("browser-journey");
  const dirtyFiles = [{ path: "SKILL.md", content: skillText("Retained unsaved edit") }];
  await textOf().fill(dirtyFiles[0].content);
  const importedFiles = [
    { path: "SKILL.md", content: skillText("Native file import") },
    { path: "resources/nested/lección%20.txt", content: "Resource π, percent %, accented text.\n" },
  ];
  const inputFiles = importedFiles.map(({ path, content }) => ({
    name: encodeURIComponent(path),
    mimeType: "text/plain",
    buffer: Buffer.from(content),
  }));
  const input = authoring.locator('input[type="file"]');
  const writesBeforeImport = writes();
  await input.setInputFiles(inputFiles);
  await expect(authoring.getByRole("alertdialog")).toBeVisible();
  await click(authoring, "Cancel import");
  await p.draftFiles(authoring, dirtyFiles);
  assert.deepEqual(plainFiles(await p.readSkill()), initialFiles);
  await input.setInputFiles(inputFiles);
  await expect(authoring.getByRole("alertdialog")).toBeVisible();
  await click(authoring, "Replace draft files");
  await p.draftFiles(authoring, importedFiles);
  assert.deepEqual(writes(), writesBeforeImport);
  const native = await saveSkill();
  await p.verifyBundle(native, importedFiles);
  const downloads = [];
  for (const file of importedFiles) {
    const download = await p.exportFile(authoring, `Export saved ${file.path}`);
    assert.equal(download.name, encodeURIComponent(file.path));
    assert.equal(download.buffer.toString("utf8"), file.content);
    downloads.push(download);
  }
  await textOf().fill(skillText("Temporary edit before reimport"));
  await authoring
    .getByLabel("File text", { exact: true })
    .nth(1)
    .fill("Dirty resource to preserve");
  const dirtyRoundtrip = [
    { path: "SKILL.md", content: skillText("Temporary edit before reimport") },
    { path: importedFiles[1].path, content: "Dirty resource to preserve" },
  ];
  await input.setInputFiles(downloads);
  await expect(authoring.getByRole("alertdialog")).toBeVisible();
  await click(authoring, "Cancel import");
  await p.draftFiles(authoring, dirtyRoundtrip);
  await p.verifyBundle(await p.readSkill(), importedFiles);
  await input.setInputFiles(downloads);
  await expect(authoring.getByRole("alertdialog")).toBeVisible();
  await click(authoring, "Replace draft files");
  await p.draftFiles(authoring, importedFiles);
  // Restoring identical bytes is clean and does not manufacture another write.
  await expect(
    authoring.getByRole("button", { name: "Save personal skill (blocked)", exact: true }),
  ).toBeDisabled();
  await p.verifyBundle(await p.readSkill(), importedFiles);

  // Explicit reload, exact identity/digest enable, source replacement, stale preservation, disable.
  await reloadTeaching();
  const selected = { id: native.id, digest: native.digest };
  const checkbox = teaching.locator('.teaching-skills-didactic input[type="checkbox"]');
  const exactCheckbox = teaching.locator(`input[value="${selected.id}:${selected.digest}"]`);
  await expect(exactCheckbox).toHaveCount(1);
  await exactCheckbox.check();
  const enabled = await saveTeaching();
  assert.deepEqual(enabled.settings.selection.didactic, [selected]);
  const frozen = await p.verifyTeaching(enabled);
  assert.deepEqual(frozen.content.didacticSkills.map(plainFiles), [importedFiles]);
  const beforeReplacement = teachingPosts();
  const replacementFiles = [
    { path: "SKILL.md", content: skillText("Replacement digest") },
    importedFiles[1],
  ];
  await textOf().fill(replacementFiles[0].content);
  const replacement = await saveSkill();
  assert.notEqual(replacement.digest, native.digest);
  await p.verifyBundle(replacement, replacementFiles);
  assert.deepEqual(teachingPosts(), beforeReplacement);
  assert.deepEqual(await p.verifyTeaching(enabled), frozen);
  await reloadTeaching();
  await expect(teaching.locator(".teaching-selection-stale")).toContainText(selected.digest);
  await expect(
    teaching.locator(`input[value="${replacement.id}:${replacement.digest}"]`),
  ).not.toBeChecked();
  assert.deepEqual(await p.verifyTeaching(enabled), frozen);
  await teaching
    .locator(".teaching-selection-stale")
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  const disabled = await saveTeaching();
  assert.deepEqual(disabled.settings.selection.didactic, []);
  await p.verifyTeaching(originalTwo, "class:two");
  await expect(checkbox).toHaveCount(4);

  // One class selector drives both modules: dirty drafts need one explicit decision, and
  // declining keeps every draft while accepting discards them before either module navigates.
  await teaching
    .getByRole("textbox", { name: /^Guided mode instructions/ })
    .fill("Dirty teaching survives authoring");
  const navDraft = [
    { path: "SKILL.md", content: skillText("Dirty authoring survives teaching") },
    importedFiles[1],
  ];
  await textOf().fill(navDraft[0].content);
  const beforeNavigation = writes();
  page.once("dialog", (dialog) => dialog.dismiss());
  await classSelection(page).selectOption("class:two");
  await expect(classSelection(page)).toHaveValue("class:one");
  await expect(teaching.getByRole("textbox", { name: /^Guided mode instructions/ })).toHaveValue(
    "Dirty teaching survives authoring",
  );
  await p.draftFiles(authoring, navDraft);
  page.once("dialog", (dialog) => dialog.accept());
  await p.action(`${TEACHING}/catalog`, () => classSelection(page).selectOption("class:two"));
  await p.idle(teaching);
  await p.idle(authoring);
  await expect(classSelection(page)).toHaveValue("class:two");
  await expect(authoring.getByLabel("File text", { exact: true })).toHaveCount(0);
  await expect(
    teaching.getByRole("textbox", { name: /^Guided mode instructions/ }),
  ).not.toHaveValue("Dirty teaching survives authoring");
  assert.deepEqual(writes(), beforeNavigation);
  await teaching
    .getByRole("textbox", { name: /^Guided mode instructions/ })
    .fill("Dirty class two");
  await p.verifyTeaching(disabled);
  await p.verifyTeaching(originalTwo, "class:two");

  // Real competing HTTP writes cause independent conflicts; readback and adoption are explicit.
  await openPersonal("browser-journey");
  await textOf().fill(skillText("Local recovery draft"));
  const concurrentFiles = [
    { path: "SKILL.md", content: skillText("Other tab committed") },
    importedFiles[1],
  ];
  const concurrent = await p.api(
    `${AUTHORING}/save`,
    envelope("skill-authoring-save", {
      classId: "class:two",
      expectedDigest: replacement.digest,
      draft: { kind: "didactic", slug: "browser-journey", files: concurrentFiles },
    }),
  );
  const concurrentTeaching = await p.api(
    `${TEACHING}/save`,
    envelope("teaching-configuration-save", {
      classId: "class:two",
      expectedVersion: originalTwo.version,
      settings: {
        ...originalTwo.settings,
        classInstructions: {
          ...originalTwo.settings.classInstructions,
          tutoring: "Other tab teaching",
        },
      },
    }),
  );
  const beforeRecoveryAuthoring = authoringPosts();
  await p.action(`${TEACHING}/save`, () => click(teaching, "Save configuration"), 409);
  await p.idle(teaching);
  await expect(teaching.getByRole("alert")).toHaveText(
    "The saved configuration changed while you were editing.",
  );
  await expect(textOf()).toHaveValue(skillText("Local recovery draft"));
  assert.deepEqual(authoringPosts(), beforeRecoveryAuthoring);
  const beforeRecoveryTeaching = teachingPosts();
  await p.action(`${AUTHORING}/save`, () => click(authoring, "Save personal skill"), 409);
  await p.idle(authoring);
  await expect(authoring.getByRole("alert")).toHaveText(
    "The personal skill changed while you were editing.",
  );
  assert.deepEqual(teachingPosts(), beforeRecoveryTeaching);
  await reloadTeaching();
  await expect(teaching.locator(".teaching-recovery")).toContainText("Other tab teaching");
  await expect(teaching.getByRole("textbox", { name: /^Guided mode instructions/ })).toHaveValue(
    "Dirty class two",
  );
  await expect(textOf()).toHaveValue(skillText("Local recovery draft"));
  await click(teaching, "Accept current configuration");
  await expect(teaching.getByRole("textbox", { name: /^Guided mode instructions/ })).toHaveValue(
    "Other tab teaching",
  );
  const afterTeachingRecovery = teachingPosts();
  await p.action(`${AUTHORING}/read`, () => click(authoring, "Reload personal content"));
  await p.idle(authoring);
  await expect(authoring.locator(".skill-authoring-recovery")).toContainText(
    skillText("Other tab committed"),
  );
  await expect(textOf()).toHaveValue(skillText("Local recovery draft"));
  await click(authoring, "Accept current readback");
  await p.draftFiles(authoring, concurrentFiles);
  assert.deepEqual(teachingPosts(), afterTeachingRecovery);
  await p.verifyBundle(concurrent.skill, concurrentFiles);
  await p.verifyTeaching(concurrentTeaching.configuration, "class:two");
  await p.verifyTeaching(disabled);

  // Authenticated wrong-role/wrong-class plus malformed/core/stale attempts leave all state intact.
  const beforeDenialsOne = p.storedTeaching();
  const beforeDenialsTwo = p.storedTeaching("class:two");
  const validSave = envelope("skill-authoring-save", {
    classId: "class:one",
    expectedDigest: concurrent.skill.digest,
    draft: { kind: "didactic", slug: "browser-journey", files: concurrentFiles },
  });
  await p.api(
    `${AUTHORING}/save`,
    { ...validSave, draft: { ...validSave.draft, slug: "../unsafe" } },
    400,
  );
  await p.api(
    `${AUTHORING}/save`,
    {
      ...validSave,
      draft: { ...validSave.draft, files: [{ path: "../outside.txt", content: "No write" }] },
    },
    400,
  );
  await p.api(`${AUTHORING}/save`, { ...validSave, expectedDigest: native.digest }, 409);
  await p.api(
    `${AUTHORING}/save`,
    { ...validSave, target: { scope: "catalog", skillId: "marea/core-practice" } },
    400,
  );
  const stranger = await browser.newContext();
  await p.login(stranger, "teacher2");
  await p.api(`${AUTHORING}/save`, validSave, 403, stranger);
  const student = await browser.newContext();
  const studentLogin = await p.login(student, "student1");
  assert.equal(studentLogin.principal.role, "student");
  // Student login deliberately issues no teacher cookie. Also test a valid student token in that slot.
  assert.deepEqual(await student.cookies(), []);
  await p.api(`${AUTHORING}/save`, validSave, 403, student, {
    cookie: `marea_teacher_session=${studentLogin.session.token}`,
  });
  const unauthenticated = await browser.newContext();
  await p.api(`${AUTHORING}/save`, validSave, 401, unauthenticated);
  await p.verifyBundle(await p.readSkill(), concurrentFiles);
  assert.deepEqual(p.storedTeaching(), beforeDenialsOne);
  assert.deepEqual(p.storedTeaching("class:two"), beforeDenialsTwo);
  const coreAfter = await p.api(
    `${AUTHORING}/read`,
    envelope("skill-authoring-read", {
      classId: "class:one",
      target: { scope: "catalog", skillId: "marea/core-practice" },
    }),
  );
  assert.deepEqual(coreAfter.skill, core.skill);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await p.verifyErrors([
    // This host composes no administrator governance; the teacher's access probe is rejected.
    ["/api/v1/dashboard/governance/access", 404],
    [`${TEACHING}/save`, 409],
    [`${AUTHORING}/save`, 409],
  ]);
  console.log(
    "TEACHING composed browser acceptance passed: two classes, create/validate/copy/edit, native encoded resources, exact selection and immutable content, shared class navigation/conflict recovery, durable SQLite/files and authorization denials.",
  );
} catch (error) {
  if (page !== undefined && !page.isClosed()) {
    console.error("Synthetic dashboard at failure:", await page.locator("body").innerText());
    await page.screenshot({ path: `${root}/failure.png`, fullPage: true });
  }
  throw error;
} finally {
  await browser?.close();
}
