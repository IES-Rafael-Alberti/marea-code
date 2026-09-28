/* global process, console, document */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE);
const { chromium } = require("playwright");
const browser = await chromium.launch({ headless: true, channel: "chrome" });
try {
  for (const locale of ["en", "es", "eu"]) {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(
      `http://127.0.0.1:5198/dashboard/browser/typed-module-host.html?locale=${locale}`,
    );
    const click = (name) => page.getByRole("button", { name, exact: true }).click();
    const inspect = async () => {
      await click("Inspect");
      return JSON.parse(await page.locator("output").textContent());
    };
    await page.getByRole("textbox", { name: "Library draft" }).fill("Library unsaved");
    await click("Seed drafts");
    await page.waitForFunction(() => document.querySelector("output")?.textContent === "seeded");
    await click("Theme");
    await click("Layout");
    assert.equal(
      await page.getByRole("textbox", { name: "Library draft" }).inputValue(),
      "Library unsaved",
    );
    const retained = await inspect();
    assert.equal(retained.same, true);
    assert.equal(retained.notice, "Synthetic notice draft");
    assert.equal(retained.evaluation, "Synthetic evaluation draft");
    assert.equal(retained.run, "run:synthetic");
    assert.equal(retained.mounts, 1);
    await click("Toggle");
    await click("Resolve late");
    assert.deepEqual(await inspect(), { mounts: 1, stops: 1, aborted: 1, late: 0, same: false });
    await click("Toggle");
    await page.getByRole("textbox", { name: "Library draft" }).waitFor();
    await click("Class");
    await page.getByRole("textbox", { name: "Library draft" }).waitFor();
    const changed = await inspect();
    assert.equal(changed.stops, 2);
    assert.equal(changed.aborted, 2);
    await click("Logout");
    await click("Resolve late");
    assert.deepEqual(await inspect(), { mounts: 3, stops: 3, aborted: 3, late: 0, same: false });
    assert.deepEqual(errors, []);
    await page.close();
    console.log(`Typed module browser: ${locale} passed`);
  }
} finally {
  await browser.close();
}
