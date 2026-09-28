/* global process, console */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE);
const { chromium } = require("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
try {
  const page = await browser.newPage({ locale: "en" });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto(`${process.argv[2]}/dashboard/`);
  await page.getByLabel("Username", { exact: true }).fill("teacher");
  await page.getByLabel("Password", { exact: true }).fill("teacher-password");
  await page.locator(".session-form button[type=submit]").click();
  await page.locator(".profile-shell > label select").first().selectOption("class:one");
  const panel = page.getByRole("region", { name: "Telemetry preview", exact: true });
  await panel.getByText("Telemetry enabled", { exact: true }).waitFor();
  await panel.getByText("Configured destinations: 2", { exact: true }).waitFor();
  await panel.locator("summary").click();
  const body = await panel.locator("pre").innerText();
  assert.match(body, /operation.duration-ms/);
  assert.doesNotMatch(body, /synthetic-secret|synthetic-public|private-student/);
  assert.equal(await panel.locator("input,select,textarea").count(), 0);
  assert.deepEqual(errors, []);
  await page.screenshot({ path: "/tmp/marea-enabled-telemetry.png", fullPage: true });
  console.log(
    "Real compiled host browser: enabled telemetry and two generated destinations passed.",
  );
} finally {
  await browser.close();
}
