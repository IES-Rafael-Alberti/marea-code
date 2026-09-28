import { join } from "node:path";
import { z } from "zod";

import { validateDashboardProfileRelease } from "../../dashboard-profiles/release.js";
import { readBoundedBytes } from "../operator/operator-filesystem-loader.js";
import { currentUid, privateDescendantKind } from "../operator-cli/private-path.js";
import { bundledDashboardProfileRelease } from "../teacher-host/bundled-profile-composition.js";
import { readTeacherHostConfig } from "../teacher-host/teacher-host-config.js";

const REMEDY =
  "Stop the host; deploy matching compiled binaries and the complete generated dashboard dist (including .vite/manifest.json); rerun installation status before installation upgrade-profiles.";

function readAsset(root: string, path: string, limit: number): Buffer {
  if (privateDescendantKind(root, path, currentUid()) !== "file") throw new Error();
  return readBoundedBytes(path, limit);
}

function hasCatalogRevision(content: Buffer, revision: string): boolean {
  return ['"', "'", "`"].some((quote) => content.includes(`${quote}${revision}${quote}`));
}

/** Verify Vite's complete emitted graph, including lazy plugins, without executing browser code. */
function validateAssets(dist: string, revision: string): void {
  const asset = z.string().regex(/^assets\/[A-Za-z0-9_.-]+$/u);
  const entry = z.object({
    file: asset,
    imports: z.array(z.string()).max(128).default([]),
    dynamicImports: z.array(z.string()).max(128).default([]),
    css: z.array(asset).max(128).default([]),
    assets: z.array(asset).max(128).default([]),
    isEntry: z.boolean().optional(),
  });
  const manifest = z
    .record(z.string(), entry)
    .parse(
      JSON.parse(
        new TextDecoder("utf-8", { fatal: true }).decode(
          readAsset(dist, join(dist, ".vite", "manifest.json"), 65_536),
        ),
      ),
    );
  const entries = Object.values(manifest);
  if (entries.length > 128) throw new Error();
  const main = entry.extend({ isEntry: z.literal(true) }).parse(manifest["index.html"]);
  const index = readAsset(dist, join(dist, "index.html"), 65_536);
  if (!index.includes(`/dashboard/${main.file}`)) throw new Error();
  const files = new Set<string>();
  for (const item of entries) {
    for (const dependency of [...item.imports, ...item.dynamicImports])
      if (!Object.hasOwn(manifest, dependency)) throw new Error();
    for (const file of [item.file, ...item.css, ...item.assets]) files.add(file);
  }
  if (files.size > 128) throw new Error();
  let bytes = 0;
  for (const file of files) {
    const content = readAsset(dist, join(dist, file), 4_194_304);
    bytes += content.byteLength;
    if (bytes > 16_777_216) throw new Error();
    if (file === main.file && !hasCatalogRevision(content, revision)) throw new Error();
  }
}

/** Read-only deployment prerequisite; no storage handle, lock, migration or external I/O. */
export function profileReleaseReadiness(root: string, releaseId: string) {
  let reason = "host-release-config";
  try {
    const host = readTeacherHostConfig(root);
    if (host.releaseId !== releaseId) throw new Error();
    reason = "generated-catalog";
    const release = validateDashboardProfileRelease(bundledDashboardProfileRelease());
    reason = "dashboard-assets-or-catalog-revision";
    validateAssets(host.dashboardDistPath, release.revision);
    return { ready: true, reason: "ready", catalogRevision: release.revision, remedy: REMEDY };
  } catch {
    return { ready: false, reason, catalogRevision: null, remedy: REMEDY };
  }
}
