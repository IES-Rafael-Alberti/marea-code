import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dashboardCatalogRevision } from "@marea/plugin-runtime";
import { teacherHostInstallation } from "../teacher-host/teacher-host.fixture.js";

/** Minimal emitted graph; compiled acceptance separately uses Vite's actual output. */
export function profileUpgradeInstallation() {
  const fixture = teacherHostInstallation();
  const dist = fixture.host.dashboardDistPath;
  mkdirSync(join(dist, ".vite"), { mode: 0o700 });
  const write = (path: string, value: string | Uint8Array) => {
    writeFileSync(join(dist, path), value, { mode: 0o600 });
  };
  const manifest = {
    "index.html": {
      file: "assets/main.js",
      isEntry: true,
      dynamicImports: ["plugin"],
      css: ["assets/main.css"],
    },
    plugin: { file: "assets/plugin.js", imports: ["index.html"] },
  };
  const writeManifest = (value: unknown) => {
    write(".vite/manifest.json", JSON.stringify(value));
  };
  writeManifest(manifest);
  write("index.html", '<script src="/dashboard/assets/main.js"></script>');
  write("assets/main.js", `const revision = ${JSON.stringify(dashboardCatalogRevision)};`);
  write("assets/plugin.js", "export {};");
  write("assets/main.css", ":root {}");
  return { ...fixture, writeAsset: write, writeManifest, manifest };
}
