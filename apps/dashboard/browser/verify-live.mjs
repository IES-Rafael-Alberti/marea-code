/* global console, process, window */

import { createRequire } from "node:module";
import { Buffer } from "node:buffer";

let chromium;
let expect;
try {
  const require = createRequire(import.meta.url);
  ({ chromium } = require("playwright"));
  ({ expect } = require("playwright/test"));
  if (typeof chromium?.launch !== "function" || typeof expect !== "function") {
    throw new Error("the installed Playwright test entry did not provide chromium and expect");
  }
} catch (error) {
  const detail = error instanceof Error ? `: ${error.message}` : "";
  throw new Error(
    `Playwright is unavailable. Install it in the workspace or set PLAYWRIGHT_NODE_PATH to a directory containing it${detail}`,
    { cause: error },
  );
}

const baseUrl =
  process.env.DASHBOARD_BROWSER_URL ??
  "http://127.0.0.1:5173/dashboard/browser/skill-authoring-live.html";
const pageErrors = [];
const consoleErrors = [];
let browser;

async function readText(page, testId) {
  return (await page.getByTestId(testId).textContent()) ?? "";
}

async function assertDraft(page, expected, label) {
  const expectedText = JSON.stringify(expected);
  await expect(page.getByTestId("draft-state"), label).toHaveText(expectedText);
  await expect(page.getByTestId("resource-state"), `${label} resources`).toHaveText(
    JSON.stringify(expected.files.filter((file) => file.path !== "SKILL.md")),
  );
}

async function assertNoPrompt(page, label) {
  await expect(page.getByRole("alertdialog"), label).toHaveCount(0);
}

async function assertPrompt(page, label) {
  await expect(page.getByRole("alertdialog"), label).toBeVisible();
}

async function resolveOldest(page, label) {
  const pending = JSON.parse(await readText(page, "directory-pending-ids"));
  const operation = pending.find(({ label: pendingLabel }) => pendingLabel === label);
  if (operation === undefined) {
    throw new Error(`No pending directory import labeled ${label}: ${JSON.stringify(pending)}`);
  }
  await page.getByRole("button", { name: `resolve import ${operation.id}` }).click();
  await expect(page.getByTestId("last-import-label"), `${label} was resolved`).toHaveText(label);
}

async function captureDownload(page, buttonName) {
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: buttonName }).click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  if (stream === null) throw new Error(`Playwright did not provide a stream for ${buttonName}`);
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const failure = await download.failure();
  if (failure !== null) throw new Error(`download failed for ${buttonName}: ${failure}`);
  return { name: download.suggestedFilename(), content: Buffer.concat(chunks).toString("utf8") };
}

async function reset(page, initialDraft) {
  await page.getByRole("button", { name: "reset editor" }).click();
  await assertDraft(page, initialDraft, "reset preserves the complete original draft");
  await expect(page.getByTestId("directory-pending")).toHaveText("0");
  await assertNoPrompt(page, "reset clears any staged import");
}

async function setInputFiles(page, inputFiles) {
  const input = page.locator('input[type="file"]');
  await input.setInputFiles(inputFiles);
  await expect(input).toHaveValue("");
  return input;
}

async function confirmDirectoryImport(page, label, expectedDraft, description) {
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, label);
  await assertPrompt(page, `${description} stages a fresh import`);
  await page.getByRole("button", { name: "Replace draft files" }).click();
  await assertDraft(page, expectedDraft, `${description} applies the complete fresh file list`);
  await assertNoPrompt(page, `${description} consumes the prompt`);
}

try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.setDefaultTimeout(2_000);
  page.setDefaultNavigationTimeout(5_000);
  page.on("pageerror", (error) => pageErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "domcontentloaded" });
  await expect(page.getByTestId("draft-state")).toBeVisible();
  const initialDraft = JSON.parse(await readText(page, "draft-state"));
  if (process.env.MAREA_BROWSER_PROOF_FAIL === "1") {
    throw new Error("intentional browser-proof assertion failure for cleanup verification");
  }
  const holdSeconds = Number(process.env.MAREA_BROWSER_PROOF_HOLD_SECONDS ?? "0");
  if (Number.isFinite(holdSeconds) && holdSeconds > 0) {
    await new Promise((resolve) => globalThis.setTimeout(resolve, holdSeconds * 1_000));
  }

  // Dirty replacement is complete-list replacement; cancel keeps every edit and resource.
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "cancel");
  await assertPrompt(page, "dirty import stages a confirmation");
  await page.getByRole("button", { name: "Cancel import" }).click();
  await assertNoPrompt(page, "cancel removes the staged prompt");
  await assertDraft(page, initialDraft, "cancel preserves every draft edit and resource");

  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "replace");
  await assertPrompt(page, "dirty replacement remains explicit");
  await page.getByRole("button", { name: "Replace draft files" }).click();
  const replacedDraft = {
    ...initialDraft,
    files: [{ path: "SKILL.md", content: "replace only main" }],
  };
  await assertDraft(page, replacedDraft, "replace drops resources absent from the import");
  await assertNoPrompt(page, "replacement consumes the prompt");

  await page.getByRole("button", { name: "mark clean" }).click();
  await expect(page.getByTestId("dirty-state")).toHaveText("false");
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "clean");
  const cleanImportDraft = {
    ...replacedDraft,
    files: [
      { path: "SKILL.md", content: "clean main" },
      { path: "resources/clean.txt", content: "clean resource" },
    ],
  };
  await assertNoPrompt(page, "clean import does not stage confirmation");
  await assertDraft(page, cleanImportDraft, "clean import replaces the entire file list");

  // A staged import is revoked as soon as a newer operation begins.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "stage-A");
  await assertPrompt(page, "stage A is visible before B begins");
  await page.getByRole("button", { name: "Import directory" }).click();
  await expect(page.getByTestId("directory-pending")).toHaveText("1");
  await assertNoPrompt(page, "starting delayed B immediately revokes staged A");
  await assertDraft(page, initialDraft, "starting B preserves the current draft");
  await resolveOldest(page, "stage-B");
  await assertPrompt(page, "B is the only import eligible for confirmation");
  await page.getByRole("button", { name: "Replace draft files" }).click();
  await assertDraft(
    page,
    { ...initialDraft, files: [{ path: "SKILL.md", content: "staged B" }] },
    "only B can be confirmed after A is revoked",
  );

  // B resolves before late A; the older A operation must never win.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await page.getByRole("button", { name: "Import directory" }).click();
  await expect(page.getByTestId("directory-pending")).toHaveText("2");
  await resolveOldest(page, "order-B");
  await assertPrompt(page, "newer B is current before late A resolves");
  await resolveOldest(page, "order-A");
  await assertPrompt(page, "late A cannot replace the staged B prompt");
  await page.getByRole("button", { name: "Replace draft files" }).click();
  await assertDraft(
    page,
    { ...initialDraft, files: [{ path: "SKILL.md", content: "late B" }] },
    "B-before-late-A applies B alone",
  );

  // Pending and staged operations are invalidated by the complete busy roundtrip.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await expect(page.getByTestId("busy-state")).toHaveText("false");
  await page.getByRole("button", { name: "set busy true" }).click();
  await expect(page.getByTestId("busy-state")).toHaveText("true");
  await assertNoPrompt(page, "pending import is invalidated when busy starts");
  await assertDraft(page, initialDraft, "pending busy transition preserves the draft");
  await page.getByRole("button", { name: "set busy false" }).click();
  await expect(page.getByTestId("busy-state")).toHaveText("false");
  await resolveOldest(page, "pending-busy");
  await assertNoPrompt(page, "pending import cannot return after busy recovery");
  await assertDraft(page, initialDraft, "busy recovery keeps the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-pending-busy",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after pending busy" }] },
    "fresh pending-busy recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "staged-busy");
  await assertPrompt(page, "staged import exists before busy starts");
  await page.getByRole("button", { name: "set busy true" }).click();
  await expect(page.getByTestId("busy-state")).toHaveText("true");
  await assertNoPrompt(page, "staged import is invalidated when busy starts");
  await assertDraft(page, initialDraft, "staged busy transition preserves the draft");
  await page.getByRole("button", { name: "set busy false" }).click();
  await expect(page.getByTestId("busy-state")).toHaveText("false");
  await assertNoPrompt(page, "busy false does not resurrect staged content");
  await assertDraft(page, initialDraft, "busy false keeps the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-staged-busy",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after staged busy" }] },
    "fresh staged-busy recovery",
  );

  // An actual textarea edit invalidates a pending import and remains observable state.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await page.getByLabel("File text").first().fill("newer draft edit");
  const editedDraft = {
    ...initialDraft,
    files: [{ path: "SKILL.md", content: "newer draft edit" }, ...initialDraft.files.slice(1)],
  };
  await assertDraft(page, editedDraft, "the editor callback updates real React draft state");
  await resolveOldest(page, "pending-edit");
  await assertNoPrompt(page, "draft edit invalidates the pending import");
  await assertDraft(page, editedDraft, "late import cannot overwrite a newer draft edit");
  await confirmDirectoryImport(
    page,
    "fresh-pending-edit",
    { ...editedDraft, files: [{ path: "SKILL.md", content: "fresh after pending edit" }] },
    "fresh pending-edit recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "staged-edit");
  await assertPrompt(page, "staged import exists before a newer edit");
  await page.getByLabel("File text").first().fill("newer draft edit after staging");
  const stagedEditedDraft = {
    ...initialDraft,
    files: [
      { path: "SKILL.md", content: "newer draft edit after staging" },
      ...initialDraft.files.slice(1),
    ],
  };
  await assertNoPrompt(page, "newer edit invalidates the staged import");
  await assertDraft(page, stagedEditedDraft, "staged invalidation preserves the newer edit");
  await confirmDirectoryImport(
    page,
    "fresh-staged-edit",
    { ...stagedEditedDraft, files: [{ path: "SKILL.md", content: "fresh after staged edit" }] },
    "fresh staged-edit recovery",
  );

  // Navigation and recovery context roundtrips never revive an old operation.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await page.getByRole("button", { name: "navigate away" }).click();
  await expect(page.getByTestId("context-state")).toHaveText("away:editor");
  await assertNoPrompt(page, "navigation invalidates a pending import");
  await assertDraft(page, initialDraft, "navigation preserves the draft");
  await page.getByRole("button", { name: "return original context" }).click();
  await expect(page.getByTestId("context-state")).toHaveText("original:editor");
  await resolveOldest(page, "pending-navigation");
  await assertNoPrompt(page, "returning to the original context does not revive the import");
  await assertDraft(page, initialDraft, "the original context preserves the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-pending-navigation",
    {
      ...initialDraft,
      files: [{ path: "SKILL.md", content: "fresh after pending navigation" }],
    },
    "fresh pending-navigation recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "staged-navigation");
  await assertPrompt(page, "staged navigation scenario has a prompt");
  await page.getByRole("button", { name: "navigate away" }).click();
  await page.getByRole("button", { name: "return original context" }).click();
  await assertNoPrompt(page, "navigation does not revive a staged import");
  await assertDraft(page, initialDraft, "staged navigation preserves the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-staged-navigation",
    {
      ...initialDraft,
      files: [{ path: "SKILL.md", content: "fresh after staged navigation" }],
    },
    "fresh staged-navigation recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await expect(page.getByTestId("directory-pending")).toHaveText("1");
  await assertNoPrompt(page, "pending recovery starts without a prompt");
  await page.getByRole("button", { name: "enter recovery context" }).click();
  await expect(page.getByTestId("context-state")).toHaveText("original:recovery");
  await expect(page.getByTestId("directory-pending")).toHaveText("1");
  await assertNoPrompt(page, "recovery invalidates pending content");
  await assertDraft(page, initialDraft, "recovery preserves the exact draft");
  await page.getByRole("button", { name: "leave recovery context" }).click();
  await expect(page.getByTestId("context-state")).toHaveText("original:editor");
  await expect(page.getByTestId("directory-pending")).toHaveText("1");
  await assertNoPrompt(page, "leaving recovery does not resurrect staged content");
  await assertDraft(page, initialDraft, "recovery roundtrip preserves the exact draft");
  await resolveOldest(page, "pending-recovery");
  await expect(page.getByTestId("directory-pending")).toHaveText("0");
  await assertNoPrompt(page, "late pending recovery cannot return after the roundtrip");
  await assertDraft(page, initialDraft, "late recovery preserves the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-pending-recovery",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after pending recovery" }] },
    "fresh pending-recovery recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "staged-recovery");
  await assertPrompt(page, "staged recovery scenario has a prompt");
  await page.getByRole("button", { name: "enter recovery context" }).click();
  await page.getByRole("button", { name: "leave recovery context" }).click();
  await assertNoPrompt(page, "recovery does not revive a staged import");
  await assertDraft(page, initialDraft, "staged recovery preserves the exact draft");
  await confirmDirectoryImport(
    page,
    "fresh-staged-recovery",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after staged recovery" }] },
    "fresh staged-recovery recovery",
  );

  // Disposal invalidates both pending and staged operations and cannot update an unmounted editor.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await page.getByRole("button", { name: "unmount editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import directory", exact: true })).toHaveCount(0);
  await resolveOldest(page, "pending-unmount");
  await expect(page.getByTestId("directory-pending")).toHaveText("0");
  await assertDraft(page, initialDraft, "pending unmount preserves the outer React draft state");
  await assertNoPrompt(page, "pending unmount cannot display a prompt");
  await page.getByRole("button", { name: "mount editor", exact: true }).click();
  await expect(page.getByRole("button", { name: "Import directory", exact: true })).toBeVisible();
  await assertDraft(page, initialDraft, "pending unmount remount preserves the exact draft");
  await assertNoPrompt(page, "pending unmount remount cannot resurrect a prompt");
  await confirmDirectoryImport(
    page,
    "fresh-pending-unmount",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after pending unmount" }] },
    "fresh pending-unmount recovery",
  );

  await reset(page, initialDraft);
  await page.getByRole("button", { name: "Import directory" }).click();
  await resolveOldest(page, "staged-unmount");
  await assertPrompt(page, "staged unmount has a prompt before disposal");
  await page.getByRole("button", { name: "unmount editor", exact: true }).click();
  await assertNoPrompt(page, "staged unmount cannot display a prompt");
  await page.getByRole("button", { name: "mount editor", exact: true }).click();
  await assertNoPrompt(page, "remount does not resurrect staged content");
  await assertDraft(page, initialDraft, "staged unmount preserves the exact outer draft");
  await confirmDirectoryImport(
    page,
    "fresh-staged-unmount",
    { ...initialDraft, files: [{ path: "SKILL.md", content: "fresh after staged unmount" }] },
    "fresh staged-unmount recovery",
  );

  // The unchanged native exchange roundtrips encoded draft download names.
  await reset(page, initialDraft);
  const downloads = [
    await captureDownload(page, "Export draft SKILL.md"),
    await captureDownload(page, "Export draft resources/keep.txt"),
    await captureDownload(page, "Export draft resources/nested/lección%20.txt"),
  ];
  if (
    JSON.stringify(downloads.map(({ name }) => name)) !==
    JSON.stringify([
      "draft__SKILL.md",
      "draft__resources%2Fkeep.txt",
      "draft__resources%2Fnested%2Flecci%C3%B3n%2520.txt",
    ])
  ) {
    throw new Error(
      `native export names were not encoded canonically: ${JSON.stringify(downloads)}`,
    );
  }
  await page.getByRole("button", { name: "mark clean" }).click();
  await expect(page.getByTestId("dirty-state")).toHaveText("false");
  await setInputFiles(
    page,
    downloads.map(({ name, content }) => ({
      name,
      mimeType: "text/plain",
      buffer: Buffer.from(content),
    })),
  );
  await assertDraft(page, initialDraft, "native encoded export/import preserves all files");
  await assertNoPrompt(page, "clean native roundtrip does not stage");

  // Explicit input clears after success and after a failure, with exact sanitized copy.
  await reset(page, initialDraft);
  await page.getByRole("button", { name: "mark clean" }).click();
  await setInputFiles(page, {
    name: "SKILL.md",
    mimeType: "text/plain",
    buffer: Buffer.from("explicit success"),
  });
  await assertDraft(
    page,
    { ...initialDraft, files: [{ path: "SKILL.md", content: "explicit success" }] },
    "explicit import success updates real draft state",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);

  await page.getByRole("button", { name: "fail next explicit import" }).click();
  await setInputFiles(page, {
    name: "SKILL.md",
    mimeType: "text/plain",
    buffer: Buffer.from("raw failure input"),
  });
  await expect(page.getByRole("alert")).toHaveText(
    "The selected files could not be imported or exported.",
  );
  const bodyText = (await page.locator("body").textContent()) ?? "";
  if (bodyText.includes("fixture-secret-raw-error")) {
    throw new Error("the injected raw error leaked into the page");
  }
  await assertDraft(
    page,
    { ...initialDraft, files: [{ path: "SKILL.md", content: "explicit success" }] },
    "explicit failure preserves the successful draft",
  );

  const unhandledRejections = await page.evaluate(() => window.__mareaUnhandledRejections);
  if (unhandledRejections.length > 0) {
    throw new Error(`unhandled browser rejections: ${JSON.stringify(unhandledRejections)}`);
  }
  if (pageErrors.length > 0 || consoleErrors.length > 0) {
    throw new Error(`browser errors: ${JSON.stringify({ pageErrors, consoleErrors })}`);
  }
  console.log(
    "browser proof passed: complete replacement/cancel, stale lifecycle invalidation, native roundtrip, errors, and cleanup",
  );
} finally {
  await browser?.close();
}
