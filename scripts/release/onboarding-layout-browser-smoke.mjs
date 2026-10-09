import assert from "node:assert/strict";

/** Validation feedback must not resize or move either password input. */
export async function verifySetupPasswordLayout(page, validPassword) {
  const fields = page.locator('.secret-control > input[autocomplete="new-password"]');
  const measure = () =>
    fields.evaluateAll((inputs) =>
      inputs.map((input) => {
        const rect = input.getBoundingClientRect();
        return {
          x: rect.x,
          y: rect.y + globalThis.scrollY,
          width: rect.width,
          height: rect.height,
        };
      }),
    );
  const language = page.locator(".masthead select");
  for (const width of [1280, 360]) {
    await page.setViewportSize({ width, height: 900 });
    for (const locale of ["es", "en", "eu"]) {
      await language.selectOption(locale);
      if (locale === "es")
        assert.equal(
          await page.getByLabel("Nombre de tu primera clase", { exact: true }).count(),
          1,
        );
      await fields.nth(0).fill(validPassword);
      await fields.nth(1).fill(validPassword);
      await language.focus();
      const before = await measure();
      await fields.nth(0).fill("short");
      await fields.nth(1).focus();
      assert.equal(await fields.nth(0).getAttribute("aria-invalid"), "true");
      assert.deepEqual(await measure(), before, `${locale}/${width}: short password moved inputs`);
      await fields.nth(0).fill(validPassword);
      await fields.nth(1).fill("different-password");
      await language.focus();
      assert.equal(await fields.nth(1).getAttribute("aria-invalid"), "true");
      assert.deepEqual(await measure(), before, `${locale}/${width}: mismatch moved inputs`);
      await fields.nth(1).fill(validPassword);
      await language.focus();
      assert.deepEqual(
        await measure(),
        before,
        `${locale}/${width}: clearing feedback moved inputs`,
      );
    }
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await language.selectOption("en");
}
