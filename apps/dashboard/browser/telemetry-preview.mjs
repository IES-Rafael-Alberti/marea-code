/* global process, console, document, getComputedStyle */
import { createRequire } from "node:module";
import { once } from "node:events";
import { spawn } from "node:child_process";
import assert from "node:assert/strict";
import { classSelection, openDiagnostics, signOut } from "./workspace-navigation.mjs";
const installedPlaywright = createRequire(process.env.PLAYWRIGHT_PACKAGE);
const { chromium } = installedPlaywright("playwright");
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_EXECUTABLE,
});
const origin = "http://127.0.0.1:5196";
const errors = [];
const copy = {
  en: [
    "Telemetry preview",
    "Telemetry disabled",
    "Configured destinations: 0",
    "Refresh preview",
    "Select a class to preview the policy.",
  ],
  es: [
    "Vista previa de telemetría",
    "Telemetría desactivada",
    "Destinos configurados: 0",
    "Actualizar vista previa",
    "Selecciona una clase para ver la política.",
  ],
  eu: [
    "Telemetriaren aurrebista",
    "Telemetria desgaituta",
    "Konfiguratutako helmugak: 0",
    "Eguneratu aurrebista",
    "Hautatu ikasgela bat politika ikusteko.",
  ],
};
async function journey(legacy) {
  const host = spawn(process.env.MAREA_PROFILE_HOST, legacy ? ["--legacy"] : [], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  try {
    await Promise.race([
      once(host.stdout, "data"),
      once(host, "exit").then(([code]) => {
        throw new Error(`Host exited: ${code}`);
      }),
    ]);
    for (const locale of Object.keys(copy)) {
      const context = await browser.newContext({
        locale: "en",
        viewport: { width: 1280, height: 900 },
        reducedMotion: "reduce",
      });
      try {
        const page = await context.newPage();
        page.on("pageerror", (error) => errors.push(error.message));
        const requests = [];
        page.on("request", (request) => requests.push(request.url()));
        await page.goto(`${origin}/dashboard/`);
        assert.equal(await page.locator(".telemetry-preview").count(), 0);
        await page.getByLabel("Username", { exact: true }).fill("teacher");
        await page.getByLabel("Password", { exact: true }).fill("teacher-password");
        await page.locator(".interface-language select").selectOption(locale);
        await page.locator(".session-form button[type=submit]").click();
        await page.locator(".telemetry-preview").waitFor({ state: "attached" });
        await openDiagnostics(page);
        await page.locator(".telemetry-preview").waitFor();
        const [title, disabled, destinations, refresh, empty] = copy[locale];
        const panel = page.getByRole("region", { name: title, exact: true });
        await panel.getByText(empty, { exact: true }).waitFor();
        assert.equal(requests.filter((url) => url.endsWith("telemetry/preview")).length, 0);
        const selection = classSelection(page);
        await selection.selectOption("class:ready");
        await panel.getByText(disabled, { exact: true }).waitFor();
        if (!legacy) {
          const profileCopy = {
            en: ["Dashboard appearance", "Save", "Read current state"],
            es: ["Aspecto del panel", "Guardar", "Leer estado actual"],
            eu: ["Panelaren itxura", "Gorde", "Uneko egoera irakurri"],
          }[locale];
          const editor = page.locator(".profile-editor");
          await editor.locator("summary").filter({ hasText: profileCopy[0] }).click();
          await editor.getByRole("button", { name: profileCopy[1], exact: true }).waitFor();
          await editor.getByRole("button", { name: profileCopy[2], exact: true }).waitFor();
          assert.equal(await page.locator("html").getAttribute("lang"), locale);
        }

        await panel.getByText(destinations, { exact: true }).waitFor();
        await panel.locator("summary").focus();
        await page.keyboard.press("Enter");
        const envelope = JSON.parse(await panel.locator("pre").innerText());
        assert.deepEqual(envelope.attributes, [
          { key: "operation.duration-ms", classification: "operational", value: 125 },
          { key: "operation.succeeded", classification: "operational", value: "[REDACTED]" },
        ]);
        assert.equal(await panel.locator("input, select, textarea").count(), 0);
        assert.equal(await panel.getByRole("status").getAttribute("aria-live"), "polite");
        const button = panel.getByRole("button", { name: refresh });
        await button.focus();
        assert.notEqual(
          await button.evaluate((element) => getComputedStyle(element).outlineStyle),
          "none",
        );
        await page.keyboard.press("Enter");
        await panel.getByText(disabled, { exact: true }).waitFor();
        await page.setViewportSize({ width: 320, height: 700 });
        assert.equal(
          await page.evaluate(
            () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
          ),
          true,
        );
        await page.emulateMedia({ forcedColors: "active" });
        await button.focus();
        assert.notEqual(
          await button.evaluate((element) => getComputedStyle(element).outlineStyle),
          "none",
        );
        await page.emulateMedia({ forcedColors: "none" });
        // The combined host remains the authority for class denial (no route interception).
        const denied = await context.request.post(`${origin}/api/v1/dashboard/telemetry/preview`, {
          headers: { origin },
          data: {
            protocolVersion: "0.1",
            requestId: "preview:denied",
            kind: "telemetry-preview",
            classId: "class:foreign",
          },
        });
        assert.equal(denied.status(), 403);
        // A class change remounts the preview for the new class; there is no class-less workspace.
        await selection.selectOption("class:other");
        await panel.getByText(disabled, { exact: true }).waitFor();
        if (locale === "en" && !legacy) await failureAndLifecycle(page, panel, selection);
        assert.equal(
          requests.every((url) => url.startsWith(origin)),
          true,
        );
        await page.screenshot({
          path: `/tmp/telemetry-ui-${legacy ? "schema9" : "schema10"}-${locale}.png`,
          fullPage: true,
        });
      } finally {
        await context.close();
      }
    }
    console.log(
      `Schema ${legacy ? 9 : 10}: es/en/eu authenticated preview, keyboard, narrow viewport, forced colors and class authorization passed.`,
    );
  } finally {
    if (host.exitCode === null) {
      const exited = once(host, "exit");
      host.kill("SIGTERM");
      await exited;
    }
  }
}
async function failureAndLifecycle(page, panel, selection) {
  // Supplemental fault injection is distinct from the real HTTP acceptance above.
  let status = 500;
  await page.route("**/telemetry/preview", (route) =>
    route.fulfill({ status, body: "private-error-not-for-display" }),
  );
  await selection.selectOption("class:ready");
  await panel.getByText("Telemetry preview is unavailable. Try again.", { exact: true }).waitFor();
  status = 403;
  await panel.getByRole("button", { name: "Refresh preview" }).click();
  await panel
    .getByText("Access denied. Sign in again or select an authorized class.", { exact: true })
    .waitFor();
  await page.unroute("**/telemetry/preview");
  let release;
  let received;
  const arrived = new Promise((resolve) => {
    received = resolve;
  });
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/telemetry/preview", async (route) => {
    const response = await route.fetch();
    received();
    await gate;
    // Switching class aborts the held request, so the page may already have handled it.
    await route.fulfill({ response }).catch(() => undefined);
  });
  await panel.getByRole("button", { name: "Refresh preview" }).click();
  await arrived;
  await panel.getByText("Loading telemetry preview…", { exact: true }).waitFor();
  await selection.selectOption("class:other");
  release();
  await page.unroute("**/telemetry/preview");
  // The held response belongs to the previous class and never reaches the remounted preview.
  await panel.getByText(copy.en[1], { exact: true }).waitFor();
  assert.equal(await panel.getByText("Loading telemetry preview…", { exact: true }).count(), 0);
  await selection.selectOption("class:ready");
  await panel.getByText(copy.en[1], { exact: true }).waitFor();
  await signOut(page);
  await page.getByRole("button", { name: "Sign in", exact: true }).waitFor();
  assert.equal(await page.locator(".telemetry-preview").count(), 0);
  assert.equal(await page.getByText("[REDACTED]", { exact: false }).count(), 0);
}
try {
  await journey(false);
  await journey(true);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
