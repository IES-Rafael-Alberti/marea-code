/* global process */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { URL } from "node:url";

import { newDiagnosticContext } from "./browser-acceptance-context.mjs";

const require = createRequire(import.meta.url);
const { expect } = require("playwright/test");

export const GOVERNANCE = "/api/v1/dashboard/governance";

export function envelope(kind, fields = {}) {
  return { protocolVersion: "0.1", requestId: `request:${randomUUID()}`, kind, ...fields };
}

/** Reads the proof URL from the environment and returns it with its origin. */
export function acceptanceTarget(label) {
  const baseUrl = process.env[`${label}_ACCEPTANCE_URL`];
  if (!baseUrl) throw new Error(`${label}_ACCEPTANCE_URL is required`);
  return { baseUrl, origin: new URL(baseUrl).origin };
}

/** Signs in through the product API and opens a page that records browser problems. */
export async function signedInPage(browser, origin, login, password, problems) {
  const context = await newDiagnosticContext(browser);
  const response = await context.request.post(`${origin}/v1/auth/login`, {
    headers: { origin },
    data: envelope("credential-login", { credentials: { login, password } }),
  });
  assert.equal(response.status(), 200, `${login} signs in`);
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  page.on("pageerror", (error) => problems.push(`${login} page error: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // Expected rejected governance reads are reported by the browser as resource failures.
    if (message.text().startsWith("Failed to load resource")) return;
    problems.push(`${login} console: ${message.text()}`);
  });
  return { context, page };
}

/** An ordinary teacher's access probe is rejected and no administration module renders. */
export async function expectTeacherWithoutAdministration(session, baseUrl) {
  const denied = session.page.waitForResponse((response) =>
    response.url().endsWith(`${GOVERNANCE}/access`),
  );
  await session.page.goto(baseUrl);
  assert.equal((await denied).status(), 403, "teacher access is rejected by the server");
  await expect(session.page.locator(".governance-module")).toHaveCount(0);
  await session.context.close();
}

/** Opens the administration module and returns it with its center navigation. */
export async function openAdministration(page, baseUrl, centerCount) {
  await page.goto(baseUrl);
  const module = page.locator(".governance-module");
  await expect(module.getByRole("heading", { name: "Center administration" })).toBeVisible();
  const centers = module.getByRole("navigation", { name: "Centers" });
  await expect(centers.locator("li")).toHaveCount(centerCount);
  return { module, centers };
}
