import { expect, it } from "vitest";
import { release } from "./release.fixture.js";
import { validateDashboardProfileRelease } from "./release.js";

function catalogAtBytes(bytes: number) {
  const modules = Array.from({ length: 64 }, (_, i) => ({
    ...release.modules[0],
    id: `org.marea.module-${String(i)}`,
    optionalDependencies: Array.from({ length: 32 }, (_, n) => `org.dep-${String(n)}.a`),
  }));
  const defaults = { ...release.defaults, modules: [] };
  const envelope = {
    protocolVersion: "0.1",
    requestId: "r".repeat(128),
    kind: "dashboard-profile-catalog-result",
    scope: { kind: "class", classId: "c".repeat(128) },
    catalogRevision: release.revision,
    modules,
    themes: release.themes,
    releaseDefaults: defaults,
  };
  let remaining = bytes - new TextEncoder().encode(JSON.stringify(envelope)).byteLength;
  for (const module of modules) {
    module.optionalDependencies = module.optionalDependencies.map((dependency) => {
      const add = Math.min(remaining, 160 - dependency.length);
      remaining -= add;
      return dependency + "a".repeat(add);
    });
  }
  expect(remaining).toBe(0);
  expect(new TextEncoder().encode(JSON.stringify(envelope)).byteLength).toBe(bytes);
  return { ...release, modules, defaults };
}
it("accepts the precise catalog response byte limit and rejects one additional byte", () => {
  expect(validateDashboardProfileRelease(catalogAtBytes(262_144)).modules).toHaveLength(64);
  expect(() => validateDashboardProfileRelease(catalogAtBytes(262_145))).toThrow(
    "Dashboard plugin catalog: response exceeds byte limit. Rebuild or enable compatible release artifacts.",
  );
});
