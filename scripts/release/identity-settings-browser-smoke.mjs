/* global getComputedStyle */
import assert from "node:assert/strict";

/** Exercise private identity settings through the actual dashboard without contacting Google. */
export async function verifyIdentitySettings(page) {
  const accounts = page.getByRole("button", { name: "School accounts", exact: true });
  await accounts.click();
  assert.equal(
    await accounts.evaluate((button) => getComputedStyle(button).borderLeftWidth),
    "0px",
  );
  const panel = page.locator(".identity-settings");
  await panel.getByLabel("School Google Workspace", { exact: true }).check();
  await panel.getByLabel("OAuth client ID", { exact: true }).fill("synthetic-ux-client");
  await panel.getByLabel("OAuth client secret", { exact: true }).fill("synthetic-ux-secret");
  await panel.getByLabel("School domain", { exact: true }).fill("school.test");
  await page.getByRole("button", { name: "Network and installation", exact: true }).click();
  await page.getByRole("button", { name: "School accounts", exact: true }).click();
  assert.equal(
    await panel.getByLabel("School domain", { exact: true }).inputValue(),
    "school.test",
  );
  await panel.getByRole("button", { name: "Save configuration", exact: true }).click();
  await panel.getByRole("status").filter({ hasText: "Restart marea-teacher" }).waitFor();
  assert.equal(await panel.getByLabel("OAuth client secret", { exact: true }).inputValue(), "");
  assert.ok(await panel.getByText("Key saved · Change", { exact: true }).isVisible());
  await panel.getByLabel("School domain", { exact: true }).fill("draft.test");
  await panel.getByRole("button", { name: "Discard changes", exact: true }).click();
  assert.equal(
    await panel.getByLabel("School domain", { exact: true }).inputValue(),
    "school.test",
  );
  await panel.getByText("Key saved · Change", { exact: true }).click();
  await panel.getByLabel("OAuth client ID", { exact: true }).fill("synthetic-updated-client");
  await panel.getByRole("button", { name: "Save configuration", exact: true }).click();
  await panel.locator('form[data-dirty="false"]').waitFor();
  assert.equal(
    await panel.getByLabel("OAuth client ID", { exact: true }).inputValue(),
    "synthetic-updated-client",
  );
  assert.equal(await panel.getByLabel("OAuth client secret", { exact: true }).inputValue(), "");
}
