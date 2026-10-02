/** Locale-independent navigation through the teacher workspace, by position in its menus. */
const views = ["sessions", "map", "progress", "reports", "settings"];
const settings = ["classroom", "server", "panel", "administration"];

export function classSelection(page) {
  return page.locator(".workspace-class select");
}

export async function openView(page, view) {
  await page.locator(".workspace-navigation button").nth(views.indexOf(view)).click();
}

/** The profile editor, diagnostics, health and usage live in the "panel" settings page. */
export async function openSettings(page, part = "panel") {
  await openView(page, "settings");
  await page.locator(".settings-navigation button").nth(settings.indexOf(part)).click();
}

/** Signing out lives in the account menu of the masthead. */
export async function signOut(page, name = "Sign out") {
  const menu = page.locator(".account-menu");
  if ((await menu.count()) > 0 && (await menu.getAttribute("open")) === null)
    await menu.locator("summary").click();
  await page.getByRole("button", { name, exact: true }).click();
}

/** Opens "My dashboard" and expands its diagnostics disclosure (telemetry preview). */
export async function openDiagnostics(page) {
  await openSettings(page);
  const details = page.locator(".settings-page:not([hidden]) > details.workspace-advanced").nth(1);
  if ((await details.getAttribute("open")) === null) await details.locator("> summary").click();
}
