import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { cleanupTeacherHostInstallations } from "../teacher-host/teacher-host.fixture.js";
import { profileReleaseReadiness } from "./profile-release-readiness.js";
import { profileUpgradeInstallation } from "./profile-upgrade.fixture.js";
vi.mock("bun:sqlite", () => import("../operator-cli/bun-sqlite.fixture.js"));
afterEach(cleanupTeacherHostInstallations);

it.each(["imports", "dynamicImports", "css", "assets"])(
  "bounds %s even when entries are repeated",
  (key) => {
    const f = profileUpgradeInstallation();
    const reference = key.endsWith("mports") ? "plugin" : "assets/plugin.js";
    const manifest = (length: number) => ({
      ...f.manifest,
      "index.html": { ...f.manifest["index.html"], [key]: Array.from({ length }, () => reference) },
    });
    f.writeManifest(manifest(128));
    expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
    f.writeManifest(manifest(129));
    expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
  },
);

it("accepts the maximum catalog entries and rejects an existing asset outside assets", () => {
  const f = profileUpgradeInstallation();
  f.writeManifest({
    ...f.manifest,
    ...Object.fromEntries(
      Array.from({ length: 126 }, (_, i) => [String(i), { file: "assets/plugin.js" }]),
    ),
  });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
  f.writeManifest({ ...f.manifest, plugin: { file: "index.html" } });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
});

it("accepts exactly 128 emitted files, including binary assets", () => {
  const f = profileUpgradeInstallation();
  const assets = Array.from({ length: 125 }, (_, i) => `assets/Extra_${String(i)}-a.bin`);
  for (const path of assets) f.writeAsset(path, "");
  f.writeManifest({ ...f.manifest, "index.html": { ...f.manifest["index.html"], assets } });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
  f.writeAsset("assets/binary.bin", new Uint8Array([255, 0]));
  f.writeManifest({
    ...f.manifest,
    "index.html": { ...f.manifest["index.html"], assets: [...assets, "assets/binary.bin"] },
  });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
  f.writeManifest({
    ...f.manifest,
    "index.html": { ...f.manifest["index.html"], assets: ["assets/binary.bin"] },
  });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
});

it("counts raw asset bytes and permits the exact per-file and aggregate maxima", () => {
  const f = profileUpgradeInstallation();
  const main = f.manifest["index.html"];
  // Four full chunks: reuse the existing entry's literal revision and remove other content.
  const revision = profileReleaseReadiness(f.root, "release:host").catalogRevision;
  const prefix = JSON.stringify(revision);
  f.writeAsset(main.file, prefix.padEnd(4_194_304, " "));
  f.writeAsset("assets/plugin.js", "");
  f.writeAsset("assets/main.css", "");
  const assets = ["assets/a.bin", "assets/b.bin", "assets/c.bin"];
  for (const path of assets) f.writeAsset(path, "x".repeat(4_194_304));
  f.writeManifest({ ...f.manifest, "index.html": { ...main, assets } });
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(true);
  f.writeAsset("assets/plugin.js", "x");
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
});

it("rejects malformed UTF-8 even in ignored build metadata", () => {
  const f = profileUpgradeInstallation();
  const before = JSON.stringify({
    ...f.manifest,
    "index.html": { ...f.manifest["index.html"], name: "INVALID" },
  });
  f.writeAsset(
    ".vite/manifest.json",
    Buffer.concat([
      Buffer.from(before.split("INVALID")[0] ?? ""),
      Buffer.from([255]),
      Buffer.from(before.split("INVALID")[1] ?? ""),
    ]),
  );
  expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
});
it.each(["nested/assets/child.js", "assets/nested/child.js"])(
  "rejects existing paths outside the flat asset grammar: %s",
  (path) => {
    const f = profileUpgradeInstallation();
    const parts = path.split("/").slice(0, -1);
    let directory = f.host.dashboardDistPath;
    for (const part of parts) {
      directory = join(directory, part);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
    }
    f.writeAsset(path, "export {};");
    f.writeManifest({ ...f.manifest, plugin: { file: path } });
    expect(profileReleaseReadiness(f.root, "release:host").ready).toBe(false);
  },
);
