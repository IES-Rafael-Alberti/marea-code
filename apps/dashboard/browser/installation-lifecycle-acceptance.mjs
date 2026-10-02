/* global console, process */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { URL } from "node:url";

import { launchAcceptanceBrowser, newDiagnosticContext } from "./browser-acceptance-context.mjs";
import {
  GOVERNANCE,
  acceptanceTarget,
  expectTeacherWithoutAdministration,
  openAdministration,
  signedInPage,
} from "./governance-acceptance-support.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("playwright/test");

// Two phases around a permanent deletion performed by the operations executable.
const { baseUrl } = acceptanceTarget("OPERATIONS");
const phase = process.env.OPERATIONS_ACCEPTANCE_PHASE;
if (!["before", "after"].includes(phase ?? ""))
  throw new Error("OPERATIONS_ACCEPTANCE_PHASE must be before or after");
const PACKAGE = {
  format: "marea-class-exchange:1",
  source: { displayName: "Imported Physics" },
  agentMode: "free",
  classInstructions: { tutoring: "Guide with questions", free: "Explore freely" },
  selection: { didactic: [], evaluation: [] },
};
const PASSWORDS = {
  admin1: "synthetic-admin-password",
  teacher1: "synthetic-teacher-password",
  student1: "synthetic-student-password",
};

let browser;
const problems = [];

function newSession(login) {
  return signedInPage(browser, new URL(baseUrl).origin, login, PASSWORDS[login], problems);
}

async function createAccount(page, accounts) {
  const response = page.waitForResponse(
    (candidate) =>
      new URL(candidate.url()).pathname === `${GOVERNANCE}/account/create` &&
      candidate.request().method() === "POST",
  );
  const form = accounts.locator("form.governance-create");
  await form.getByLabel("User ID").fill("user:leaver");
  await form.getByLabel("Display name").fill("Lea Leaver");
  await form.getByLabel("Login").fill("leaver1");
  await form.getByLabel("Initial class").selectOption({ label: "Physics" });
  await form.getByRole("button", { name: "Create" }).click();
  return (await response).status();
}

/** A teacher reaches the dashboard only through its own sign-in form and can sign out again. */
async function signInThroughTheForm() {
  const context = await newDiagnosticContext(browser);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => problems.push(`sign-in page error: ${error.message}`));
  page.on("console", (message) => {
    // Refused sign-ins and the signed-out session query are expected 401/403 responses.
    if (message.type() !== "error" || message.text().startsWith("Failed to load resource")) return;
    problems.push(`sign-in console: ${message.text()}`);
  });
  const signIn = async (login, password) => {
    await page.getByLabel("Username").fill(login);
    await page.getByLabel("Password").fill(password);
    await page.getByRole("button", { name: "Sign in" }).click();
  };
  await page.goto(baseUrl);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toHaveCount(0);

  await signIn("teacher1", "not-the-right-password");
  await expect(page.getByRole("alert")).toHaveText("The username or password is not correct.");
  await expect(page.getByLabel("Password")).toHaveValue("");
  await signIn("student1", PASSWORDS.student1);
  await expect(page.getByRole("alert")).toHaveText(
    "This dashboard is for teachers. Students use the marea application.",
  );
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toHaveCount(0);

  await signIn("teacher1", PASSWORDS.teacher1);
  // The account menu carries the signed-in identity and the sign-out action.
  const account = async () => {
    await page.locator(".account-menu > summary").click();
    await expect(page.getByText("Signed in as Tomas Teacher")).toBeVisible();
  };
  await account();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toBeVisible();
  await page.reload();
  await account();

  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sessions", exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await context.close();
}

try {
  browser = await launchAcceptanceBrowser();

  if (phase === "before") await signInThroughTheForm();

  // The ordinary teacher keeps the teacher dashboard without the administration module.
  await expectTeacherWithoutAdministration(await newSession("teacher1"), baseUrl);

  const admin = await newSession("admin1");
  const { module, centers } = await openAdministration(admin.page, baseUrl, 2);
  const open = (scope, text) =>
    scope
      .locator("li", { hasText: text })
      .getByRole("button", { name: "Open", exact: true })
      .click();
  const classes = module.locator("section.governance-classes");
  const accounts = module.locator("section.governance-accounts");
  await open(centers, "South Center");
  await expect(classes.locator(".governance-list > li")).toHaveText([/Biology/u]);
  await open(centers, "North Center");
  await expect(classes.locator(".governance-list > li")).toHaveText([/Physics/u]);
  const list = accounts.locator(".governance-list > li");
  await expect(list.filter({ hasText: "Sam Student" })).toHaveCount(1);
  await expect(list.filter({ hasText: "Tomas Teacher" })).toHaveCount(1);

  if (phase === "before") {
    assert.equal(await createAccount(admin.page, accounts), 200, "account creation succeeds");
    await expect(list.filter({ hasText: "Lea Leaver" })).toContainText("Pending credential");
    // Physics receives its teaching configuration through a reviewed browser import.
    await open(classes, "Physics");
    const exchange = classes.locator("section.governance-exchange");
    await exchange.getByLabel("Package to import").fill(JSON.stringify(PACKAGE));
    await exchange.getByRole("button", { name: "Stage package" }).click();
    await exchange.getByRole("button", { name: "Preview import" }).click();
    const preview = exchange.getByRole("region", { name: "Import preview" });
    await expect(preview).toContainText("Explore freely");
    const confirmed = admin.page.waitForResponse(
      (candidate) => new URL(candidate.url()).pathname === `${GOVERNANCE}/class/import/confirm`,
    );
    await preview.getByRole("button", { name: "Confirm import" }).click();
    assert.equal((await confirmed).status(), 200, "import confirmation succeeds");
    await expect(exchange.getByRole("region", { name: "Import preview" })).toHaveCount(0);
  } else {
    // The permanently deleted account is gone and its identity cannot be created again.
    await expect(list.filter({ hasText: "Lea Leaver" })).toHaveCount(0);
    assert.equal(await createAccount(admin.page, accounts), 409, "deleted identity is refused");
    await expect(module.getByRole("alert")).toBeVisible();
    await module.getByRole("button", { name: "Reload" }).click();
    await expect(list.filter({ hasText: "Sam Student" })).toHaveCount(1);
    await expect(list.filter({ hasText: "Lea Leaver" })).toHaveCount(0);
  }
  await admin.context.close();
  assert.deepEqual(problems, [], "no browser errors, rejections or CSP violations");
  console.log(`OPERATIONS_BROWSER_${phase.toUpperCase()}_PASSED`);
} finally {
  await browser?.close();
}
