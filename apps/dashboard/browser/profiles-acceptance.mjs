/* global console, process, document, getComputedStyle, URL */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { sessionsModule } from "./release-browser-checks.mjs";
const require = createRequire(process.env.PLAYWRIGHT_PACKAGE);
const { chromium } = require("playwright");
const catalog = JSON.parse(await readFile("/tmp/profiles-dashboard-browser-catalog.json", "utf8"));
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const origin = "http://127.0.0.1:5194";
const errors = [];
const NOW = "2026-09-22T10:00:00.000Z";
try {
  for (const locale of ["en", "es", "eu"]) {
    const context = await browser.newContext({ locale, viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", (error) => errors.push(error.message));
    const records = new Map();
    let revisions = 0;
    let writes = 0;
    let queries = 0;
    let failWrite = false;
    let catalogMismatch = false;
    const record = (scope) =>
      records.get(scope.kind === "teacher" ? "teacher" : scope.classId) ?? {
        revision: null,
        updatedAt: null,
        status: "default",
        value: null,
      };
    const state = (body) => {
      const personal = record({ kind: "teacher" });
      const override = body.scope.kind === "teacher" ? null : record(body.scope);
      const effective = { ...catalog.releaseDefaults, ...personal.value, ...override?.value };
      return {
        ...body,
        kind: "dashboard-profile-state",
        schemaVersion: 1,
        generatedAt: NOW,
        catalogRevision: catalogMismatch ? "a".repeat(64) : catalog.catalogRevision,
        personal,
        override,
        effective: { ...effective, modules: effective.modules.filter((item) => item.enabled) },
        warnings: [],
      };
    };
    await page.route("**/api/**", async (route) => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      const body = request.postDataJSON() ?? {};
      const envelope = { protocolVersion: "0.1", requestId: body.requestId };
      const send = (data, status = 200, headers = {}) =>
        route.fulfill({
          status,
          headers: { "content-type": "application/json", "cache-control": "no-store", ...headers },
          body: JSON.stringify(data),
        });
      if (path.endsWith("/session/login"))
        return send(
          {
            ...envelope,
            kind: "dashboard-session",
            principal: { role: "teacher", displayName: "Synthetic teacher" },
          },
          200,
          { "set-cookie": "synthetic_teacher=yes; Path=/; HttpOnly; SameSite=Strict" },
        );
      if (!(await request.allHeaders()).cookie?.includes("synthetic_teacher=yes"))
        return send({}, 401);
      if (path.endsWith("/session/logout"))
        return send({ ...envelope, kind: "credential-logout-result" }, 401, {
          "set-cookie": "synthetic_teacher=; Max-Age=0; Path=/",
        });
      if (path.endsWith("/session"))
        return send({
          ...envelope,
          kind: "dashboard-session",
          principal: { role: "teacher", displayName: "Synthetic teacher" },
        });
      if (path.endsWith("/teaching/classes"))
        return send({
          ...envelope,
          kind: "teaching-classes-response",
          classes: [
            { classId: "class:a", displayName: "Synthetic class A" },
            { classId: "class:b", displayName: "Synthetic class B" },
          ],
          nextAfterClassId: null,
        });
      if (path.includes("/profiles/")) {
        const base = { ...envelope, scope: body.scope };
        if (path.endsWith("/catalog"))
          return send({
            ...catalog,
            ...base,
            catalogRevision: catalogMismatch ? "a".repeat(64) : catalog.catalogRevision,
          });
        if (path.endsWith("/save") || path.endsWith("/reset")) {
          writes++;
          const key = body.scope.kind === "teacher" ? "teacher" : body.scope.classId;
          if (
            body.expectedRevision !== record(body.scope).revision ||
            body.expectedPersonalRevision !== record({ kind: "teacher" }).revision
          )
            return send({}, 409);
          const value = path.endsWith("/save") ? body.value : null;
          records.set(key, {
            revision: `revision:${++revisions}`,
            updatedAt: NOW,
            status: value === null ? "default" : "valid",
            value,
          });
          if (failWrite) {
            failWrite = false;
            return route.abort("failed");
          }
        }
        return send(state(base));
      }
      if (path.endsWith("/history/classes")) {
        assert.ok(body.classId, "module must never issue an unscoped class query");
        queries++;
        return send({
          ...envelope,
          kind: "class-sessions-response",
          runs: [],
          nextBeforeRunId: null,
        });
      }
      return send({}, 403);
    });
    await page.goto(`${origin}/dashboard/`);
    await page.locator('input[autocomplete="username"]').fill("synthetic");
    await page.locator('input[type="password"]').fill("synthetic-password");
    await page.locator('form button[type="submit"]').click();
    await page.locator(".profile-editor summary").click();
    await page.locator(".profile-editor select").first().waitFor();
    assert.equal(queries, 0);
    await page.locator(".profile-shell > label select").first().selectOption("class:a");
    await page.waitForFunction(() => document.querySelector(".session-workspace"));
    const editor = page.locator(".profile-editor");
    // Independently override modules, disable, and confirm polling has stopped.
    await editor.locator('input[type="checkbox"]').nth(1).uncheck();
    await sessionsModule(editor).locator('input[type="checkbox"]').uncheck();
    await page.waitForFunction(() => !document.querySelector(".session-workspace"));
    const stopped = queries;
    await page.waitForTimeout(2300);
    assert.equal(queries, stopped);
    await sessionsModule(editor).locator('input[type="checkbox"]').check();
    await page.waitForFunction(() => document.querySelector(".session-workspace"));
    await editor.locator('input[type="checkbox"]').nth(0).uncheck();
    await editor.locator("select").first().selectOption("org.marea.theme.high-contrast");
    await page.waitForFunction(
      () =>
        getComputedStyle(document.documentElement).getPropertyValue("--color-text").trim() ===
        "#000000",
    );
    // Save loses its response: readback is automatic, writing is never replayed.
    failWrite = true;
    await editor
      .locator("fieldset > button")
      .filter({ hasText: /^(Save|Guardar|Gorde)$/ })
      .click();
    await editor.locator('[role="alert"]').waitFor();
    assert.equal(writes, 1);
    await editor
      .getByRole("button", {
        name: /^(Accept current state|Aceptar estado actual|Uneko egoera onartu)$/,
      })
      .click();
    assert.equal(writes, 1);
    await sessionsModule(editor).locator("select").first().selectOption("aside");
    await sessionsModule(editor).locator("select").nth(1).selectOption("compact");
    assert.equal(await page.locator(".profile-slot-aside.profile-size-compact").count(), 1);
    // Another tab advances the revision; conflict readback retains this tab's draft.
    records.set("class:a", { ...records.get("class:a"), revision: "revision:other-tab" });
    await editor.getByRole("button", { name: /^(Save|Guardar|Gorde)$/ }).click();
    await editor.locator('[role="alert"]').waitFor();
    assert.equal(writes, 2);
    await editor
      .getByRole("button", {
        name: /^(Keep draft against current revision|Conservar borrador sobre la revisión actual|Zirriborroa uneko berrikuspenarekin mantendu)$/,
      })
      .click();
    assert.equal(await sessionsModule(editor).locator("select").first().inputValue(), "aside");
    // Keyboard focus, narrow viewport, zoom, forced colors and reduced motion.
    await page.keyboard.press("Tab");
    assert.notEqual(
      await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle),
      "none",
    );
    await page.setViewportSize({ width: 360, height: 800 });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
    );
    await page.evaluate(() => {
      document.documentElement.style.zoom = "200%";
    });
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= document.documentElement.clientWidth,
      ),
      "zoom must reflow without horizontal scrolling",
    );
    await page.emulateMedia({ forcedColors: "active", reducedMotion: "reduce" });
    assert.equal(
      await page.evaluate(() => getComputedStyle(document.querySelector("button")).animationName),
      "none",
    );
    await page.screenshot({ path: `/tmp/profiles-dashboard-${locale}.png`, fullPage: true });
    catalogMismatch = true;
    await editor
      .getByRole("button", {
        name: /^(Read current state|Leer estado actual|Uneko egoera irakurri)$/,
      })
      .click();
    await editor.locator('[role="alert"]').waitFor();
    assert.ok(await editor.getByRole("button", { name: /^(Save|Guardar|Gorde)$/ }).isDisabled());
    assert.equal(writes, 2);
    await page.locator(".session-bar button").click();
    await page.locator('input[type="password"]').waitFor();
    const signedOutQueries = queries;
    await page.waitForTimeout(2300);
    assert.equal(queries, signedOutQueries);
    assert.equal(await page.locator(".profile-shell").count(), 0);
    await context.close();
    console.log(`${locale}: authenticated synthetic profile/lifecycle/accessibility checks passed`);
  }
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
}
