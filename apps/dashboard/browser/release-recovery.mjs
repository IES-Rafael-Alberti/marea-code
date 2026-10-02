/* global process, console, document, getComputedStyle */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { launchReleaseBrowser } from "./release-browser-runtime.mjs";
import { classSelection, openSettings, openView } from "./workspace-navigation.mjs";
const browser = await launchReleaseBrowser();
try {
  for (const mode of ["unavailable", "future"]) {
    const host = spawn(process.env.MAREA_PROFILE_HOST, [`--${mode}`], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    try {
      await Promise.race([
        once(host.stdout, "data"),
        once(host, "exit").then(() => {
          throw new Error("Host failed");
        }),
      ]);
      const context = await browser.newContext({ locale: "en" });
      try {
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.goto("http://127.0.0.1:5196/dashboard/");
        await page.getByLabel("Username", { exact: true }).fill("teacher");
        await page.getByLabel("Password", { exact: true }).fill("teacher-password");
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
        await classSelection(page).selectOption("class:ready");
        const editor = page.locator(".profile-editor");
        await openSettings(page);
        await editor.locator("summary").click();
        const message =
          mode === "future"
            ? "This profile needs recovery. Reset this scope to restore inherited defaults."
            : "Some saved preferences are unavailable. Replacing this scope discards those settings.";
        await editor.getByText(message, { exact: true }).waitFor();
        await page.waitForFunction(
          () =>
            getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim() !==
            "",
        );
        assert.equal(await page.locator(".account-menu summary").count(), 1);
        if (mode === "future") {
          assert.equal(
            await editor.getByRole("button", { name: "Save", exact: true }).isDisabled(),
            true,
          );
          await openView(page, "sessions");
          await page.locator(".session-workspace").waitFor();
        } else {
          await openView(page, "sessions");
          await page
            .getByText("This view is not enabled in your dashboard.", { exact: true })
            .waitFor();
        }
        await page.screenshot({ path: `/tmp/p4-release-recovery-${mode}.png`, fullPage: true });
        assert.deepEqual(errors, []);
        console.log(`${mode}: compiled recovery warning, fallback and usable shell passed`);
      } finally {
        await context.close();
      }
    } finally {
      if (host.exitCode === null) {
        const exited = once(host, "exit");
        host.kill("SIGTERM");
        await exited;
      }
    }
  }
} finally {
  await browser.close();
}
