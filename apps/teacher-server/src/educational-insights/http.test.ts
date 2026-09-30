import { it, expect } from "vitest";
import { Hono } from "hono";
import { EDUCATIONAL_INSIGHTS_PATH } from "@marea/protocol";
import { registerEducationalInsightsRoutes } from "../product-http/educational-insights-http.boundary.js";
import { fixture } from "./insights.fixture.js";
import { teacher } from "../../test-support/evaluation-fixture.js";
it("authorizes every request and serializes SQL-backed reports without exposing stored inputs", async () => {
  const f = fixture(),
    app = new Hono();
  registerEducationalInsightsRoutes({
    app,
    service: f.service,
    authenticate: () => teacher,
    policy: async (_context, next) => {
      await next();
    },
  });
  const post = (body: object) =>
    app.request(EDUCATIONAL_INSIGHTS_PATH, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const settings = await post(f.query({ kind: "settings" }));
  expect(settings.status).toBe(200);
  expect(await settings.json()).toMatchObject({
    data: { settings: { map: false, adaptive: false } },
  });
  expect((await post({ ...f.query({ kind: "settings" }), classId: "class:two" })).status).toBe(403);
  const generated = await post(
    f.query({
      kind: "generate",
      from: "2026-09-06T00:00:00.000Z",
      to: "2026-09-07T12:00:00.000Z",
      locale: "es",
    }),
  );
  expect(generated.status).toBe(200);
  const list = await post(f.query({ kind: "reports" }));
  expect(list.status).toBe(200);
  const text = await list.text();
  expect(text).toContain("queued");
  expect(text).not.toContain("teaching");
  expect(text).not.toContain("providerId");
  expect(
    (await post({ ...f.query({ kind: "map", viewerId: "v", visible: true }), extra: true })).status,
  ).toBe(400);
});
it("returns unavailable when educational insights are not configured", async () => {
  const app = new Hono();
  registerEducationalInsightsRoutes({
    app,
    service: undefined,
    authenticate: () => teacher,
    policy: async (_context, next) => {
      await next();
    },
  });
  const response = await app.request(EDUCATIONAL_INSIGHTS_PATH, { method: "POST" });
  expect(response.status).toBe(503);
});
