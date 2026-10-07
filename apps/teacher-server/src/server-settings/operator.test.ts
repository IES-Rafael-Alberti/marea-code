import { expect, it, vi } from "vitest";
import { serverSettingsOperator, usesCommonRoute } from "./operator.js";
import type { ServerSettings, ServerSettingsStore } from "./contracts.js";
import { syntheticOperatorPolicy } from "../teaching/configuration/dashboard-module.fixture.js";
const route = { ...syntheticOperatorPolicy.route.providerRoute, model: "server-model" };
const settings = (patch: Partial<ServerSettings> = {}): ServerSettings => ({
  version: 1,
  revision: 3,
  administrators: ["owner"],
  connections: {},
  route,
  education: {},
  useCommonRoute: false,
  legacyRoutes: [],
  ...patch,
});
const store = (value: ServerSettings | null): ServerSettingsStore => ({
  read: () => value,
  write: vi.fn(),
});
it("defaults new installations to their saved common route and supplies required tool approvals", () => {
  const fallback = { forClass: vi.fn().mockReturnValue(null) };
  const operator = serverSettingsOperator(fallback, store(settings()));
  expect(operator.forClass("class:new")).toEqual({
    route: { version: "server-route:3", modelAlias: "marea", providerRoute: route },
    teacherToolPolicy: {
      version: "policy:server-default",
      restrictions: [
        { tool: "write_file", effect: "require-approval" },
        { tool: "edit_file", effect: "require-approval" },
        { tool: "execute", effect: "require-approval" },
      ],
    },
  });
  expect(fallback.forClass).toHaveBeenCalledWith("class:new");
});
it("preserves existing aliases and tool restrictions while using the current server model", () => {
  let current = settings();
  const operator = serverSettingsOperator(
    { forClass: () => syntheticOperatorPolicy },
    { read: () => current, write: vi.fn() },
  );
  expect(operator.forClass("class:existing")).toEqual({
    ...syntheticOperatorPolicy,
    route: { ...syntheticOperatorPolicy.route, version: "server-route:3", providerRoute: route },
  });
  current = settings({ revision: 4, route: { ...route, model: "changed" } });
  expect(operator.forClass("class:existing")?.route).toMatchObject({
    version: "server-route:4",
    providerRoute: { model: "changed" },
  });
});
it("keeps legacy class routes until the administrator adopts a common model", () => {
  const legacyRoutes = [{ classId: "class:old", route }];
  expect(usesCommonRoute(settings({ legacyRoutes }))).toBe(false);
  expect(usesCommonRoute(settings({ legacyRoutes, useCommonRoute: true }))).toBe(true);
  for (const unavailable of [
    undefined,
    store(null),
    store(settings({ route: null })),
    store(settings({ legacyRoutes })),
    store(settings({ route: { providerId: "p", model: "incomplete" } })),
  ]) {
    const operator = serverSettingsOperator(
      { forClass: () => syntheticOperatorPolicy },
      unavailable,
    );
    expect(operator.forClass("class:old")).toBe(syntheticOperatorPolicy);
  }
});
