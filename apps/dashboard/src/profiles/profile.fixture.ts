import { vi } from "vitest";
import {
  dashboardModuleDescriptorLoaders,
  dashboardThemeLoaders,
} from "@marea/plugin-runtime/browser";
import {
  loadProfileCatalog,
  type ProfileState,
  type AuthorizedCatalog,
} from "./profile-catalog.js";
import type { DashboardProfileScope } from "@marea/protocol";
import type { ProfileClient } from "./profile-client.boundary.js";
export const release = await loadProfileCatalog();
export const selection = {
  moduleId: "org.marea.module.sessions",
  configurationVersion: 1,
  settings: {},
  enabled: true,
  placement: { slot: "main", size: "wide" },
} as const;
export const value = { themeId: "org.marea.theme.marea", modules: [selection] };
const descriptor = (await dashboardModuleDescriptorLoaders[selection.moduleId]()).default.manifest;
const publicModule = Object.fromEntries(
  Object.entries(descriptor).filter(([key]) => !["entrypoint", "browserEntrypoint"].includes(key)),
);
const themes = await Promise.all(
  Object.values(dashboardThemeLoaders).map(async (load) => {
    const { default: theme } = await load();
    const manifest = Object.fromEntries(
      Object.entries(theme.manifest).filter(([key]) => key !== "entrypoint"),
    );
    return { ...manifest, tokens: theme.tokens };
  }),
);
export function catalog(scope: DashboardProfileScope = { kind: "teacher" }): AuthorizedCatalog {
  return release.catalog.parse({
    kind: "dashboard-profile-catalog-result",
    protocolVersion: "0.1",
    requestId: "request:fixture",
    scope,
    catalogRevision: release.revision,
    modules: [publicModule],
    themes,
    releaseDefaults: value,
  });
}
export function state(scope: DashboardProfileScope = { kind: "teacher" }): ProfileState {
  const record = { revision: null, updatedAt: null, status: "default", value: null };
  return release.schemas.state.parse({
    kind: "dashboard-profile-state",
    schemaVersion: 1,
    protocolVersion: "0.1",
    requestId: "request:fixture",
    generatedAt: "2026-09-22T10:00:00.000Z",
    scope,
    catalogRevision: release.revision,
    personal: record,
    override: scope.kind === "teacher" ? null : record,
    effective: value,
    warnings: [],
  });
}
export function clientFixture() {
  return {
    read: vi
      .fn<ProfileClient["read"]>()
      .mockImplementation((scope) => Promise.resolve(state(scope))),
    catalog: vi
      .fn<ProfileClient["catalog"]>()
      .mockImplementation((scope) => Promise.resolve(catalog(scope))),
    save: vi.fn<ProfileClient["save"]>().mockResolvedValue(state()),
    reset: vi.fn<ProfileClient["reset"]>().mockResolvedValue(state()),
  };
}

export function confirmDiscardWindow() {
  const confirm = vi.fn().mockReturnValue(false);
  vi.stubGlobal("window", {
    confirm,
    dispatchEvent: vi.fn(),
    location: { href: "http://localhost/dashboard/" },
    history: { replaceState: vi.fn() },
  });
  return confirm;
}
