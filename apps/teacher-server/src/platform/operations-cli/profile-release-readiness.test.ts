import { chmodSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dashboardCatalogRevision } from "@marea/plugin-runtime";
import { cleanupTeacherHostInstallations } from "../teacher-host/teacher-host.fixture.js";
import * as bundled from "../teacher-host/bundled-profile-composition.js";
import { profileUpgradeInstallation } from "./profile-upgrade.fixture.js";
import { profileReleaseReadiness } from "./profile-release-readiness.js";

vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
afterEach(() => {
  vi.restoreAllMocks();
  cleanupTeacherHostInstallations();
});

describe("generated release readiness", () => {
  it("verifies matching assets in a separate private program installation", () => {
    const f = profileUpgradeInstallation();
    const programs = profileUpgradeInstallation();
    f.writeHost({ ...f.host, dashboardDistPath: programs.host.dashboardDistPath });
    expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
    chmodSync(join(programs.host.dashboardDistPath, "assets/main.js"), 0o644);
    expect(profileReleaseReadiness(f.root, "release:host")).toMatchObject({
      ready: false,
      reason: "dashboard-assets-or-catalog-revision",
    });
  });

  it.each(['"', "'", "`"])(
    "accepts minifier literal %s but not prefix/suffix catalog matches",
    (quote) => {
      const f = profileUpgradeInstallation();
      const inspect = () => profileReleaseReadiness(f.root, "release:host").ready;
      f.writeAsset("assets/main.js", `const revision=${quote}${dashboardCatalogRevision}${quote};`);
      expect(inspect()).toBe(true);
      f.writeAsset(
        "assets/main.js",
        `const revision=${quote}prefix${dashboardCatalogRevision}${quote};`,
      );
      expect(inspect()).toBe(false);
      f.writeAsset(
        "assets/main.js",
        `const revision=${quote}${dashboardCatalogRevision}suffix${quote};`,
      );
      expect(inspect()).toBe(false);
    },
  );

  it("accepts a complete matching graph and rejects a different host release or invalid required catalog", () => {
    const f = profileUpgradeInstallation();
    expect(profileReleaseReadiness(f.root, "release:host")).toMatchObject({
      ready: true,
      catalogRevision: dashboardCatalogRevision,
      reason: "ready",
    });
    expect(profileReleaseReadiness(f.root, "other")).toMatchObject({
      ready: false,
      reason: "host-release-config",
      catalogRevision: null,
    });
    const release = bundled.bundledDashboardProfileRelease();
    vi.spyOn(bundled, "bundledDashboardProfileRelease").mockReturnValue({
      ...release,
      requiredIds: ["missing"],
    });
    expect(profileReleaseReadiness(f.root, "release:host")).toMatchObject({
      ready: false,
      reason: "generated-catalog",
    });
  });

  it.each([
    "missing-entry",
    "not-entry",
    "entry-reference",
    "missing-import",
    "missing-dynamic-import",
    "missing-css",
    "missing-lazy-asset",
    "wrong-revision",
    "unsafe-path",
    "symlink",
    "public-file",
    "too-many-entries",
    "too-many-files",
    "total-bytes",
    "file-bytes",
  ])("rejects %s with a stable remedy", (failure) => {
    const f = profileUpgradeInstallation();
    const main = f.manifest["index.html"];
    const change = (value: object) => {
      f.writeManifest({ ...f.manifest, "index.html": { ...main, ...value } });
    };
    switch (failure) {
      case "missing-entry":
        f.writeManifest({ plugin: f.manifest.plugin });
        break;
      case "not-entry":
        change({ isEntry: false });
        break;
      case "entry-reference":
        f.writeAsset("index.html", "stale");
        break;
      case "missing-import":
        change({ imports: ["missing"] });
        break;
      case "missing-dynamic-import":
        change({ dynamicImports: ["missing"] });
        break;
      case "missing-css":
        rmSync(join(f.host.dashboardDistPath, "assets/main.css"));
        break;
      case "missing-lazy-asset":
        rmSync(join(f.host.dashboardDistPath, "assets/plugin.js"));
        break;
      case "wrong-revision":
        f.writeAsset("assets/main.js", "different");
        break;
      case "unsafe-path":
        change({ file: "../outside.js" });
        break;
      case "symlink":
        rmSync(join(f.host.dashboardDistPath, "assets/plugin.js"));
        symlinkSync(
          join(f.host.dashboardDistPath, "assets/main.js"),
          join(f.host.dashboardDistPath, "assets/plugin.js"),
        );
        break;
      case "public-file":
        chmodSync(join(f.host.dashboardDistPath, "assets/plugin.js"), 0o644);
        break;
      case "too-many-entries":
        f.writeManifest({
          ...f.manifest,
          ...Object.fromEntries(
            Array.from({ length: 127 }, (_, i) => [String(i), { file: "assets/plugin.js" }]),
          ),
        });
        break;
      case "too-many-files":
        change({ assets: Array.from({ length: 128 }, (_, i) => `assets/${String(i)}.txt`) });
        break;
      case "total-bytes": {
        const assets = Array.from({ length: 5 }, (_, i) => `assets/${String(i)}.txt`);
        for (const path of assets) f.writeAsset(path, "a".repeat(4_194_304));
        change({ assets });
        break;
      }
      case "file-bytes":
        f.writeAsset("assets/plugin.js", "a".repeat(4_194_305));
        break;
    }
    expect(profileReleaseReadiness(f.root, "release:host")).toEqual({
      ready: false,
      reason: "dashboard-assets-or-catalog-revision",
      catalogRevision: null,
      remedy: expect.stringContaining("including .vite/manifest.json") as unknown,
    });
  });
});
