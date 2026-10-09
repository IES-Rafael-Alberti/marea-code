import assert from "node:assert/strict";
import { classSelection, openView } from "../../apps/dashboard/browser/workspace-navigation.mjs";

/** A working settings page alone is not a successful handoff to the classroom. */
export async function verifyOnboardingModules(page, classroom) {
  await classSelection(page)
    .locator("option:checked")
    .filter({ hasText: classroom })
    .waitFor({ state: "attached" });
  assert.equal(await classSelection(page).inputValue(), "class:main");
  for (const [view, empty] of [
    ["sessions", "No sessions on this page."],
    ["map", "No records in this selection"],
    ["progress", "No students are enrolled in this class."],
    ["reports", "You have not generated any report yet."],
  ]) {
    await openView(page, view);
    const content = page.locator(".workspace-view:not([hidden])");
    try {
      await content.getByText(empty, { exact: true }).waitFor({ timeout: 15000 });
    } catch (error) {
      throw new Error(`Onboarding ${view} did not load: ${await content.innerText()}`, {
        cause: error,
      });
    }
    assert.equal(await content.getByRole("alert").count(), 0);
    if (view === "sessions") await content.locator(".session-live.connection-current").waitFor();
  }
  await openView(page, "sessions");
}
