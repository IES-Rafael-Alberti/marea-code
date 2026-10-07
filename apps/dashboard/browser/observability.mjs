/* global console */
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
import { openSettings, openView, classSelection } from "./workspace-navigation.mjs";

const artifacts = mkdtempSync(join(tmpdir(), "marea-observability-browser-"));
const received = [];
const collector = createServer(async (request, response) => {
  let body = "";
  for await (const chunk of request) body += chunk;
  received.push({
    path: request.url,
    authorization: request.headers.authorization,
    body: JSON.parse(body),
  });
  response.setHeader("Content-Type", "application/json");
  response.end("{}");
});
await new Promise((resolve) => collector.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${collector.address().port}`;
const host = await startReleaseHost(false, ["--observability"]);
const browser = await launchReleaseBrowser();
const page = await browser.newPage({ viewport: { width: 1360, height: 1000 } });
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
try {
  await page.goto("http://127.0.0.1:5196/dashboard/index.html");
  await page.locator('input[name="username"]').fill("teacher");
  await page.locator('input[type="password"]').fill("teacher-password");
  await page.getByLabel(/Idioma|Interface language/u).selectOption("en");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator(".workspace-navigation").waitFor();
  await openSettings(page, "server");
  const panel = page.locator(".observability-settings");
  await panel.locator("select").first().selectOption("org.marea.otlp");
  await panel.getByLabel("Collector base URL").fill(endpoint);
  await panel.getByLabel("Authorization header").fill("Bearer synthetic-only");
  await panel.getByRole("button", { name: "Test connection", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Destination accepted" }).waitFor();
  assert.equal(received.length, 1);
  assert.equal(received[0].path, "/v1/traces");
  assert.equal(received[0].authorization, "Bearer synthetic-only");
  assert.ok(JSON.stringify(received[0].body).includes("Synthetic connection test"));
  await panel.getByLabel("Enable delivery with content").check();
  await panel.getByRole("button", { name: "Save observability", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Settings saved." }).waitFor();
  assert.equal(await panel.getByLabel("Authorization header").inputValue(), "");
  await page.reload();
  await page.locator(".workspace-navigation").waitFor();
  await openSettings(page, "server");
  await panel.getByLabel("Enable delivery with content").waitFor();
  assert.equal(await panel.getByLabel("Enable delivery with content").isChecked(), true);
  await page.screenshot({ path: join(artifacts, "observability.png"), fullPage: true });
  await classSelection(page).selectOption("class:ready");
  await openView(page, "sessions");
  const exports = page.locator(".session-export").first();
  await exports.locator("summary").click();
  await exports.getByLabel("Identities").selectOption("pseudonyms");
  const pending = page.waitForEvent("download");
  await exports.getByRole("button", { name: "Download selection" }).click();
  await (await pending).saveAs(join(artifacts, "sessions.zip"));
  await exports.getByText("Download ready.", { exact: true }).waitFor();
  await page.screenshot({ path: join(artifacts, "session-export.png"), fullPage: true });
  assert.deepEqual(errors, []);
  console.log(`Observability browser acceptance passed. Synthetic artifacts: ${artifacts}`);
} finally {
  await browser.close();
  await stopReleaseHost(host);
  collector.closeAllConnections();
  await new Promise((resolve) => collector.close(resolve));
}
