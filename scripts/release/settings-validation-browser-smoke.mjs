import assert from "node:assert/strict";

/** Saving from another section must reveal and focus invalid fields in closed disclosures. */
export async function verifySettingsValidation(page) {
  const features = page.getByRole("button", { name: "Feature models", exact: true });
  await features.click();
  const field = page.locator('input[list="models-evaluation"]');
  const original = await field.inputValue();
  await field.fill("");
  await page.locator('details[data-settings-section="features"] > summary').click();
  await page.getByRole("button", { name: "Connection and model", exact: true }).click();
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  await field.waitFor({ state: "visible" });
  assert.equal(await features.getAttribute("aria-current"), "page");
  assert.equal(await field.getAttribute("aria-invalid"), "true");
  await page.waitForFunction(
    () => globalThis.document.activeElement?.getAttribute("list") === "models-evaluation",
  );
  await field.fill(original);
  const saving = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/server-settings") &&
      response.request().postDataJSON().operation === "save",
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await saving).status(), 200);
  await page.locator('.server-settings > form[data-dirty="false"]').waitFor();
  await field.fill("unsaved/model");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Discard changes", exact: true }).click();
  await page.locator('.server-settings > form[data-dirty="false"]').waitFor();
  assert.equal(await field.inputValue(), original);
  await page.getByRole("button", { name: "School accounts", exact: true }).click();
  const domain = page.getByLabel("School domain", { exact: true });
  const savedDomain = await domain.inputValue();
  await domain.fill("draft.test");
  await domain.fill(savedDomain);
  const identitySave = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/v1/dashboard/server-settings") &&
      response.request().postDataJSON().operation === "identity-save",
  );
  await page.getByRole("button", { name: "Save configuration", exact: true }).click();
  assert.equal((await identitySave).status(), 200);
  await page.locator('.identity-settings form[data-dirty="false"]').waitFor();
}
