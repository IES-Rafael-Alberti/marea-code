/* global process, console, document, getComputedStyle */
import assert from "node:assert/strict";
import {
  launchReleaseBrowser,
  startReleaseHost,
  stopReleaseHost,
} from "./release-browser-runtime.mjs";
const browser = await launchReleaseBrowser();
const origin = "http://127.0.0.1:5196";
const screenshots = process.env.MAREA_SCREENSHOTS ?? "/tmp";
const errors = [];
const copy = {
  en: {
    usage: "Usage and cost",
    health: "Service health",
    complete: "Every attempt on this page has a price.",
    selectUsage: "Select a class to see its usage.",
    selectHealth: "Select a class to see service health.",
    next: "Next page",
    previous: "Previous page",
    page: "Page",
    apply: "Show period",
    from: "From",
    invalid: "Choose a start date on or before the end date, spanning at most 31 days.",
    reservation: "Reservation estimate",
    available: "Available",
    unknown: "Unknown",
    none: "No observation",
    delivery: "Delivery is not confirmed. Configured telemetry is not proof that data arrived.",
    refresh: "Refresh health",
  },
  es: {
    usage: "Uso y coste",
    health: "Estado del servicio",
    complete: "Todos los intentos de esta página tienen precio.",
    selectUsage: "Selecciona una clase para ver su uso.",
    selectHealth: "Selecciona una clase para ver el estado del servicio.",
    next: "Página siguiente",
    previous: "Página anterior",
    page: "Página",
    apply: "Mostrar periodo",
    from: "Desde",
    invalid: "Elige una fecha de inicio anterior o igual a la de fin, con un máximo de 31 días.",
    reservation: "Estimación de la reserva",
    available: "Disponible",
    unknown: "Desconocido",
    none: "Sin observación",
    delivery:
      "La entrega no está confirmada. Tener telemetría configurada no prueba que los datos hayan llegado.",
    refresh: "Actualizar estado",
  },
  eu: {
    usage: "Erabilera eta kostua",
    health: "Zerbitzuaren egoera",
    complete: "Orri honetako saiakera guztiek dute prezioa.",
    selectUsage: "Hautatu ikasgela bat haren erabilera ikusteko.",
    selectHealth: "Hautatu ikasgela bat zerbitzuaren egoera ikusteko.",
    next: "Hurrengo orria",
    previous: "Aurreko orria",
    page: "Orria",
    apply: "Erakutsi epea",
    from: "Noiztik",
    invalid:
      "Aukeratu amaiera-data baino lehenagoko edo berdineko hasiera-data, gehienez 31 egunekoa.",
    reservation: "Erreserbaren estimazioa",
    available: "Erabilgarri",
    unknown: "Ezezaguna",
    none: "Behaketarik ez",
    delivery:
      "Bidalketa ez dago berretsita. Telemetria konfiguratuta egoteak ez du frogatzen datuak iritsi direnik.",
    refresh: "Eguneratu egoera",
  },
};
async function signIn(context, locale) {
  const page = await context.newPage();
  page.on("pageerror", (error) => errors.push(error.message));
  const requests = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto(`${origin}/dashboard/`);
  await page.getByLabel("Username", { exact: true }).fill("teacher");
  await page.getByLabel("Password", { exact: true }).fill("teacher-password");
  await page.locator(".interface-language select").selectOption(locale);
  await page.locator(".session-form button[type=submit]").click();
  await page.locator(".profile-shell").waitFor();
  return { page, requests };
}
const posted = (requests, path) => requests.filter((url) => url.endsWith(path)).length;
async function focusVisible(page, button) {
  // Enter keyboard modality first; focus after a mouse selection is not focus-visible.
  await page.keyboard.press("Shift");
  await button.focus();
  assert.notEqual(
    await button.evaluate((element) => getComputedStyle(element).outlineStyle),
    "none",
  );
}
async function modules(context, locale) {
  const m = copy[locale];
  const { page, requests } = await signIn(context, locale);
  const usage = page.getByRole("region", { name: m.usage, exact: true });
  const health = page.getByRole("region", { name: m.health, exact: true });
  await usage.getByText(m.selectUsage, { exact: true }).waitFor();
  await health.getByText(m.selectHealth, { exact: true }).waitFor();
  assert.equal(posted(requests, "/usage/query") + posted(requests, "/health/read"), 0);
  const selection = page.locator(".profile-shell > label select").first();
  await selection.selectOption("class:ready");

  // Usage: page-scoped pricing, keyset paging and the conservative reservation estimate.
  await usage.getByText(m.complete, { exact: true }).waitFor();
  assert.equal(await usage.locator("tbody tr").count(), 25);
  await usage.getByText(`${m.page} 1`, { exact: true }).waitFor();
  assert.equal(await usage.getByRole("button", { name: m.previous }).isDisabled(), true);
  const next = usage.getByRole("button", { name: m.next });
  await focusVisible(page, next);
  await page.keyboard.press("Enter");
  await usage.getByText(`${m.page} 2`, { exact: true }).waitFor();
  await usage.locator("tbody tr").nth(2).waitFor();
  assert.equal(await usage.locator("tbody tr").count(), 3);
  assert.equal(await next.isDisabled(), true);
  const open = usage.locator("tbody tr").filter({ hasText: m.reservation });
  assert.equal(await open.count(), 1);
  // Host startup turns the interrupted reservation into a conservative unknown hold.
  await open.getByText(m.unknown, { exact: true }).waitFor();
  await usage.getByRole("button", { name: m.previous }).click();
  await usage.getByText(`${m.page} 1`, { exact: true }).waitFor();
  await usage.locator("tbody tr").nth(24).waitFor();
  assert.equal(await usage.locator("tbody tr").count(), 25);

  // The 31-day bound is enforced before any request.
  const before = posted(requests, "/usage/query");
  const from = usage.getByLabel(m.from, { exact: true });
  const original = await from.inputValue();
  await from.fill("2020-01-01");
  await usage.getByRole("alert").getByText(m.invalid, { exact: true }).waitFor();
  assert.equal(await usage.getByRole("button", { name: m.apply }).isDisabled(), true);
  assert.equal(posted(requests, "/usage/query"), before);
  await from.fill(original);
  assert.equal(await usage.getByRole("alert").count(), 0);
  await usage.getByRole("button", { name: m.apply }).click();
  await usage.getByText(m.complete, { exact: true }).waitFor();
  assert.equal(posted(requests, "/usage/query"), before + 1);

  // Health: available observations keep timestamps; unmeasured delivery stays unknown.
  await health.getByText(m.delivery, { exact: true }).waitFor();
  const rows = health.locator("dl > div");
  assert.equal(await rows.count(), 4);
  await rows.nth(0).getByText(m.available, { exact: true }).waitFor();
  await rows.nth(1).getByText(m.available, { exact: true }).waitFor();
  for (const index of [2, 3]) {
    await rows.nth(index).getByText(m.unknown, { exact: true }).waitFor();
    await rows.nth(index).getByText(m.none, { exact: false }).waitFor();
  }
  assert.equal(await rows.nth(0).locator("time").count(), 1);
  await focusVisible(page, health.getByRole("button", { name: m.refresh }));

  // Narrow viewport and forced colors.
  await page.setViewportSize({ width: 320, height: 800 });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
    ),
    true,
  );
  await page.emulateMedia({ forcedColors: "active" });
  await focusVisible(page, usage.getByRole("button", { name: m.apply }));
  await page.emulateMedia({ forcedColors: "none" });
  await page.screenshot({ path: `${screenshots}/usage-health-${locale}.png`, fullPage: true });
  await page.setViewportSize({ width: 1280, height: 900 });

  // The host remains the class authority, independently of module visibility.
  for (const [path, body] of [
    [
      "usage/query",
      {
        kind: "class-usage-query",
        from: "2026-09-01T00:00:00.000Z",
        until: "2026-09-08T00:00:00.000Z",
        limit: 25,
      },
    ],
    ["health/read", { kind: "teacher-health-read" }],
  ]) {
    const denied = await context.request.post(`${origin}/api/v1/dashboard/${path}`, {
      headers: { origin },
      data: { protocolVersion: "0.1", requestId: "foreign:1", classId: "class:foreign", ...body },
    });
    assert.equal(denied.status(), 403);
  }
  await selection.selectOption("");
  await usage.getByText(m.selectUsage, { exact: true }).waitFor();
  await health.getByText(m.selectHealth, { exact: true }).waitFor();
  assert.equal(await usage.locator("table").count(), 0);
  if (locale === "en") await lifecycle(page, usage, health, selection);
  assert.equal(
    requests.every((url) => url.startsWith(origin)),
    true,
  );
}
async function lifecycle(page, usage, health, selection) {
  // Supplemental fault injection, separate from the real HTTP checks above.
  let status = 500;
  await page.route("**/dashboard/usage/query", (route) =>
    route.fulfill({ status, body: "private-diagnostic-not-for-display" }),
  );
  await page.route("**/dashboard/health/read", (route) =>
    route.fulfill({ status, body: "private-diagnostic-not-for-display" }),
  );
  await selection.selectOption("class:ready");
  await usage.getByText("Usage is unavailable. Try again.", { exact: true }).waitFor();
  await health.getByText("Service health is unavailable. Try again.", { exact: true }).waitFor();
  status = 403;
  await health.getByRole("button", { name: "Refresh health" }).click();
  await health
    .getByText("Access denied. Sign in again or select an authorized class.", { exact: true })
    .waitFor();
  await usage.getByRole("button", { name: "Refresh usage" }).click();
  await usage
    .getByText("Access denied. Sign in again or select an authorized class.", { exact: true })
    .waitFor();
  assert.equal(await page.getByText("private-diagnostic", { exact: false }).count(), 0);
  await page.unroute("**/dashboard/usage/query");
  await page.unroute("**/dashboard/health/read");
  // A response released after the class is cleared must not render.
  let release;
  let received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/dashboard/usage/query", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await usage.getByRole("button", { name: "Refresh usage" }).click();
  await arrived;
  await usage.getByText("Loading usage…", { exact: true }).waitFor();
  await selection.selectOption("");
  release();
  await usage.getByText(copy.en.selectUsage, { exact: true }).waitFor();
  await page.waitForTimeout(250);
  assert.equal(await usage.locator("table").count(), 0);
  await page.unroute("**/dashboard/usage/query");
  await selection.selectOption("class:ready");
  await usage.getByText(copy.en.complete, { exact: true }).waitFor();
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.getByRole("region", { name: copy.en.usage }).count(), 0);
  assert.equal(await page.getByRole("region", { name: copy.en.health }).count(), 0);
}
async function journey(legacy) {
  const host = await startReleaseHost(legacy);
  try {
    for (const locale of legacy ? ["en"] : Object.keys(copy)) {
      const context = await browser.newContext({
        locale: "en",
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      });
      try {
        if (legacy) {
          const { page, requests } = await signIn(context, locale);
          await page.locator(".profile-shell > label select").first().selectOption("class:ready");
          await page
            .getByText("Dashboard customization requires an offline server upgrade.", {
              exact: false,
            })
            .waitFor();
          assert.equal(await page.getByRole("region", { name: copy.en.usage }).count(), 0);
          assert.equal(await page.getByRole("region", { name: copy.en.health }).count(), 0);
          assert.equal(posted(requests, "/usage/query") + posted(requests, "/health/read"), 0);
        } else await modules(context, locale);
      } finally {
        await context.close();
      }
    }
    console.log(
      legacy
        ? "Schema 9: legacy sessions view exposes no usage or health module."
        : "Schema 10: es/en/eu usage paging, period bounds, health states, keyboard, narrow viewport, forced colors, class authority and lifecycle passed.",
    );
  } finally {
    await stopReleaseHost(host);
  }
}
try {
  await journey(false);
  await journey(true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
