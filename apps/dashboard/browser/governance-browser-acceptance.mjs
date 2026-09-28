/* global console, process */
import { createRequire } from "node:module";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { URL } from "node:url";

import { launchAcceptanceBrowser } from "./browser-acceptance-context.mjs";
import {
  GOVERNANCE,
  envelope,
  expectTeacherWithoutAdministration,
  openAdministration,
  signedInPage,
} from "./governance-acceptance-support.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("playwright/test");

const baseUrl = process.env.GOVERNANCE_ACCEPTANCE_URL;
const root = process.env.GOVERNANCE_ACCEPTANCE_ROOT;
if (!baseUrl || !root)
  throw new Error("GOVERNANCE_ACCEPTANCE_URL and GOVERNANCE_ACCEPTANCE_ROOT are required");
const origin = new URL(baseUrl).origin;
const exchange = {
  format: "marea-class-exchange:1",
  source: { displayName: "Imported Physics" },
  agentMode: "free",
  classInstructions: { tutoring: "Guide with questions", free: "Explore freely" },
  selection: { didactic: [], evaluation: [] },
};

let browser;
const problems = [];

function newSession(login) {
  return signedInPage(browser, origin, login, "synthetic-password", problems);
}

async function api(context, path, body, expected = 200) {
  const response = await context.request.post(`${origin}${GOVERNANCE}/${path}`, {
    headers: { origin },
    data: body,
  });
  assert.equal(response.status(), expected, `${path} status`);
  return response.json();
}

/** Waits for the browser's own request and matches the host's single serialized effect. */
async function effect(page, path, trigger, expected = 200) {
  const responsePromise = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === `${GOVERNANCE}/${path}` &&
      response.request().method() === "POST",
  );
  await trigger();
  const response = await responsePromise;
  assert.equal(response.status(), expected, `${path} browser status`);
  const requestId = response.request().postDataJSON().requestId;
  const observations = (await readFile(join(root, "http-proof.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter(
      (item) =>
        item.path === `${GOVERNANCE}/${path}` &&
        JSON.parse(item.requestText).requestId === requestId,
    );
  assert.equal(observations.length, 1, `exactly one host effect for ${path}`);
  assert.equal(observations[0].status, expected);
  return JSON.parse(observations[0].responseText);
}

function row(scope, text) {
  return scope.locator("li", { hasText: text });
}

async function openRow(scope, text) {
  await row(scope, text).getByRole("button", { name: "Open", exact: true }).click();
}

try {
  browser = await launchAcceptanceBrowser();

  // An ordinary teacher never receives the administration module.
  await expectTeacherWithoutAdministration(await newSession("teacher1"), baseUrl);

  const admin = await newSession("admin1");
  const { page, context } = admin;
  const { module, centers } = await openAdministration(page, baseUrl, 2);

  // Center B shows only its own class; center A is then managed through the browser.
  await openRow(centers, "South Center");
  const classes = module.locator("section.governance-classes");
  const accounts = module.locator("section.governance-accounts");
  await expect(classes.locator(".governance-list > li")).toHaveText([/Biology/u]);
  await openRow(centers, "North Center");
  await expect(classes.locator(".governance-list > li")).toHaveText([/Physics/u, /Chemistry/u]);
  await expect(accounts.locator(".governance-list > li")).toHaveText([
    /Ada Admin/u,
    /Tomas Teacher/u,
  ]);

  // Create a class, then rename it with an optimistic version check.
  await classes.getByLabel("Class ID").fill("class:robotics");
  await classes.locator("form.governance-create").getByLabel("Display name").fill("Robotics");
  const created = await effect(page, "class/create", () =>
    classes.getByRole("button", { name: "Create", exact: true }).click(),
  );
  assert.equal(created.classroom.classId, "class:robotics");
  await expect(classes.locator(".governance-list > li")).toHaveCount(3);
  await expect(row(classes, "Robotics").getByRole("button", { name: "Open" })).toHaveAttribute(
    "aria-current",
    "true",
  );
  const rename = classes.locator("form.governance-rename");
  await rename.getByLabel("Display name").fill("Robotics Lab");
  const renamed = await effect(page, "class/rename", () =>
    rename.getByRole("button", { name: "Save name" }).click(),
  );
  assert.equal(renamed.classroom.displayName, "Robotics Lab");

  // A concurrent server-side rename makes the next browser rename conflict; the draft is kept
  // until the administrator explicitly adopts the reloaded server row.
  const listed = await api(
    context,
    "classes",
    envelope("governance-classes-query", {
      centerId: "center:a",
      afterId: null,
    }),
  );
  const robotics = listed.items.find((item) => item.classId === "class:robotics");
  await api(
    context,
    "class/rename",
    envelope("governance-class-rename", {
      centerId: "center:a",
      classId: "class:robotics",
      displayName: "Robotics Workshop",
      expectedVersion: robotics.version,
    }),
  );
  await rename.getByLabel("Display name").fill("Robotics Studio");
  await effect(
    page,
    "class/rename",
    () => rename.getByRole("button", { name: "Save name" }).click(),
    409,
  );
  await expect(module.getByRole("alert")).toContainText("Someone changed this data first");
  await expect(rename.getByLabel("Display name")).toHaveValue("Robotics Studio");
  await module.getByRole("button", { name: "Reload" }).click();
  await expect(classes.locator(".governance-readback")).toContainText("Robotics Workshop");
  await classes.locator(".governance-readback").getByRole("button").click();
  await expect(rename.getByLabel("Display name")).toHaveValue("Robotics Workshop");

  // An account created while the response is lost stays as an unconfirmed creation and is
  // recovered from the server list without retrying the write.
  await page.route(`**${GOVERNANCE}/account/create`, async (route) => {
    await route.fetch();
    await route.abort("failed");
  });
  const createAccount = accounts.locator("form.governance-create");
  await createAccount.getByLabel("User ID").fill("user:student1");
  await createAccount.getByLabel("Display name").fill("Sara Student");
  await createAccount.getByLabel("Login").fill("sara-student");
  await createAccount.getByLabel("Initial class").selectOption({ label: "Physics" });
  await createAccount.getByRole("button", { name: "Create" }).click();
  await expect(module.getByRole("alert")).toContainText("could not be confirmed");
  await page.unroute(`**${GOVERNANCE}/account/create`);
  await expect(accounts.locator(".governance-pending-creates")).toContainText("user:student1");
  await module.getByRole("button", { name: "Reload" }).click();
  await accounts
    .locator(".governance-pending-creates")
    .getByRole("button", { name: "Show" })
    .click();
  await expect(accounts.locator(".governance-readback")).toContainText("Sara Student");
  await accounts.locator(".governance-readback").getByRole("button").click();
  await expect(accounts.locator(".governance-pending-creates")).toHaveCount(0);
  await expect(row(accounts, "Sara Student")).toContainText("Pending credential");

  // Account state and session revocation for the teacher.
  await openRow(accounts, "Tomas Teacher");
  const selectedAccount = accounts.locator(".governance-selected");
  const disabled = await effect(page, "account/state", () =>
    selectedAccount.getByRole("button", { name: "Disable" }).click(),
  );
  assert.equal(disabled.account.state, "disabled");
  await expect(row(accounts, "Tomas Teacher")).toContainText("Disabled");
  await effect(page, "account/state", () =>
    selectedAccount.getByRole("button", { name: "Enable" }).click(),
  );
  await expect(row(accounts, "Tomas Teacher")).toContainText("Active");
  await effect(page, "sessions/revoke", () =>
    selectedAccount.getByRole("button", { name: "End sessions" }).click(),
  );
  await expect(selectedAccount).toContainText("Sessions ended at");

  // Memberships of Physics: add the new student, revoke and reactivate the teacher.
  await openRow(classes, "Physics");
  const memberships = classes.locator("section.governance-memberships");
  await expect(memberships.locator(".governance-list > li")).toHaveCount(2);
  const teacherMembership = row(memberships, "Tomas Teacher");
  await effect(page, "membership/change", () =>
    teacherMembership.getByRole("button", { name: "Revoke" }).click(),
  );
  await expect(teacherMembership).toContainText("Revoked");
  await effect(page, "membership/change", () =>
    teacherMembership.getByRole("button", { name: "Add or reactivate" }).click(),
  );
  await expect(teacherMembership).toContainText("Active");

  // Import into Physics requires an explicit preview reviewed in this session.
  const exchangeSection = classes.locator("section.governance-exchange");
  await exchangeSection.getByLabel("Package to import").fill("{ not json");
  await exchangeSection.getByRole("button", { name: "Stage package" }).click();
  await expect(module.getByRole("alert")).toContainText("not valid");
  await exchangeSection.getByLabel("Package to import").fill(JSON.stringify(exchange));
  await exchangeSection.getByRole("button", { name: "Stage package" }).click();
  await expect(exchangeSection.locator(".governance-staged")).toContainText("Imported Physics");
  const previewed = await effect(page, "class/import/preview", () =>
    exchangeSection.getByRole("button", { name: "Preview import" }).click(),
  );
  const preview = exchangeSection.getByRole("region", { name: "Import preview" });
  await expect(preview).toContainText("Explore freely");
  await expect(preview.getByRole("button", { name: "Confirm import" })).toBeEnabled();
  const confirmed = await effect(page, "class/import/confirm", () =>
    preview.getByRole("button", { name: "Confirm import" }).click(),
  );
  assert.equal(confirmed.classId, "class:a");
  assert.notEqual(previewed.preview.previewId, "");
  await expect(exchangeSection.getByRole("region", { name: "Import preview" })).toHaveCount(0);
  const exported = await effect(page, "class/export", () =>
    exchangeSection.getByRole("button", { name: "Export" }).click(),
  );
  assert.equal(exported.package.agentMode, "free");
  await expect(exchangeSection.getByLabel("Exported package")).toHaveValue(/Explore freely/u);

  // A preview can be cancelled explicitly and a hidden stale preview cannot be confirmed.
  await exchangeSection
    .getByLabel("Package to import")
    .fill(JSON.stringify({ ...exchange, agentMode: "tutoring" }));
  await exchangeSection.getByRole("button", { name: "Stage package" }).click();
  await effect(page, "class/import/preview", () =>
    exchangeSection.getByRole("button", { name: "Preview import" }).click(),
  );
  await effect(page, "class/import/cancel", () =>
    exchangeSection.getByRole("button", { name: "Cancel preview" }).click(),
  );
  await expect(exchangeSection.getByRole("region", { name: "Import preview" })).toHaveCount(0);

  // Durable effects are visible through fresh authenticated HTTP reads.
  const classesAfter = await api(
    context,
    "classes",
    envelope("governance-classes-query", {
      centerId: "center:a",
      afterId: null,
    }),
  );
  assert.deepEqual(
    classesAfter.items.map((item) => item.displayName),
    ["Physics", "Robotics Workshop", "Chemistry"].sort((a, b) =>
      classesAfter.items.find((item) => item.displayName === a).classId <
      classesAfter.items.find((item) => item.displayName === b).classId
        ? -1
        : 1,
    ),
  );
  const membershipsAfter = await api(
    context,
    "memberships",
    envelope("governance-memberships-query", {
      centerId: "center:a",
      classId: "class:a",
      afterId: null,
    }),
  );
  assert.deepEqual(membershipsAfter.items.map((item) => [item.userId, item.state]).sort(), [
    ["user:student1", "active"],
    ["user:teacher", "active"],
  ]);
  const revision = await api(
    context,
    "class/revision",
    envelope("governance-class-revision-query", {
      centerId: "center:a",
      classId: "class:a",
    }),
  );
  assert.equal(revision.teachingVersion, confirmed.teachingVersion);

  await context.close();
  assert.deepEqual(problems, [], "no browser errors, rejections or CSP violations");
  console.log("GOVERNANCE_BROWSER_ACCEPTANCE_PASSED");
} finally {
  await browser?.close();
}
