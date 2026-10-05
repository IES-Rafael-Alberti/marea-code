import type { ServerSettings } from "../../server-settings/contracts.js";
import { USAGE_POLICY } from "../../../test-support/usage-fixture.js";
import { createEducationalMigrationCatalog } from "@marea/sqlite-storage/catalogs";
import { expect, it, vi } from "vitest";

vi.mock("bun:sqlite", () => import("../operations/retention/retention-bun-sqlite.fixture.js"));

import { teachingConfiguration } from "../../../test-support/teaching-fixture.js";
import { syntheticOperatorPolicy } from "../../teaching/configuration/dashboard-module.fixture.js";
import { composedHost, login, seededDatabase } from "./teacher-services.fixture.js";

it("captures a server-wide route only in new sessions and keeps an existing session frozen", async () => {
  const database = seededDatabase({
    ...teachingConfiguration("free"),
    providerRoute: syntheticOperatorPolicy.route.providerRoute,
  });
  let settings: ServerSettings = {
    version: 1,
    revision: 0,
    administrators: ["t1"],
    connections: {},
    legacyRoutes: [],
    route: { ...syntheticOperatorPolicy.route.providerRoute, model: "shared-model-one" },
    education: {},
    useCommonRoute: true,
  };
  const host = await composedHost(database, new Map(), undefined, {
    read: () => settings,
    write: (next) => {
      settings = next;
    },
  });
  try {
    const student = await host.call("/v1/auth/login", login("student", "student-password"));
    const token = (student.body.session as { token: string }).token;
    const open = (id: string) =>
      host.call(
        "/v1/runs/open",
        {
          clientSessionId: `client:${id}`,
          clientVersion: "0.2.0",
          idempotencyKey: `open:${id}`,
          intent: { kind: "new" },
          project: { displayName: "Synthetic project" },
          protocolVersion: "0.1",
          requestId: `request:${id}`,
        },
        token,
      );
    expect((await open("first")).status).toBe(201);
    const first = database.readOne("SELECT provider_route_json FROM marea_run_snapshots");
    expect(String(first?.provider_route_json)).toContain("shared-model-one");
    settings = {
      ...settings,
      revision: 1,
      route: { ...syntheticOperatorPolicy.route.providerRoute, model: "shared-model-two" },
    };
    expect((await open("second")).status).toBe(201);
    for (const [index, override] of [
      { useCommonRoute: false },
      { useCommonRoute: true, route: null },
    ].entries()) {
      settings = { ...settings, ...override };
      expect((await open(`class-route-${String(index)}`)).status).toBe(201);
    }
    const rows = database.readAll("SELECT provider_route_json FROM marea_run_snapshots");
    expect(rows.map((row) => String(row.provider_route_json))).toEqual(
      expect.arrayContaining([
        expect.stringContaining("shared-model-one"),
        expect.stringContaining("shared-model-two"),
      ]),
    );
    expect(
      rows.filter(
        (row) =>
          (JSON.parse(String(row.provider_route_json)) as { model: string }).model ===
          syntheticOperatorPolicy.route.providerRoute.model,
      ),
    ).toHaveLength(2);
  } finally {
    await host.composed.evaluations.stop();
    database.close();
  }
});

it.each([false, true])(
  "applies saved educational routes with optional insights: %s",
  async (educational) => {
    const database = seededDatabase();
    if (educational)
      for (const migration of createEducationalMigrationCatalog().slice(8))
        for (const sql of migration.statements) database.executeScript(sql);
    let settings: ServerSettings = {
      version: 1,
      revision: 0,
      administrators: ["t1"],
      connections: { "synthetic-provider": { apiKey: "synthetic-managed-key" } },
      legacyRoutes: [],
      route: null,
      education: {},
      useCommonRoute: false,
    };
    const host = await composedHost(database, new Map(), undefined, {
      read: () => settings,
      write: (next) => {
        settings = next;
      },
    });
    try {
      const map = {
        providerId: "synthetic-provider",
        model: "synthetic-map-model",
        budget: USAGE_POLICY,
        inputTokenCeiling: USAGE_POLICY.maxInputTokens,
      };
      const save = {
        operation: "save",
        expectedRevision: 0,
        connections: { "synthetic-provider": {} },
        route: null,
        education: { map },
        useCommonRoute: false,
      };
      host.composed.services.serverSettings?.execute(
        { userId: "t1", role: "teacher", classId: null, displayName: "Teacher" },
        new TextEncoder().encode(JSON.stringify(save)),
      );
      expect(settings.revision).toBe(1);
      if (educational) expect(host.composed.services.educationalInsights?.map.route).toEqual(map);
      else expect(host.composed.services).not.toHaveProperty("educationalInsights");
      expect(host.composed.services.educationalInsights?.reports.route).toBeUndefined();
    } finally {
      await host.composed.evaluations.stop();
      database.close();
    }
  },
);
