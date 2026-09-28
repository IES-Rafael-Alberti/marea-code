import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { profileReleaseReadiness } from "../src/platform/operations-cli/profile-release-readiness.js";

/** Check every copied byte, including dotfiles, and remove each real graph artifact in turn. */
export function assertReleasePackaging(root: string, dist: string) {
  const source = resolve(import.meta.dir, "../../dashboard/dist");
  const inventory = (path: string): string[] =>
    readdirSync(path, { withFileTypes: true })
      .flatMap((entry) =>
        entry.isDirectory()
          ? inventory(join(path, entry.name)).map((child) => `${entry.name}/${child}`)
          : [entry.name],
      )
      .sort();
  const files = inventory(source);
  assert.ok(files.includes(".vite/manifest.json"));
  assert.deepEqual(inventory(dist), files, "packaged dist inventory must be complete and exact");
  for (const file of files) {
    const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
    assert.equal(hash(join(dist, file)), hash(join(source, file)), file);
  }
  const manifest = z
    .record(
      z.string(),
      z.object({
        file: z.string(),
        css: z.array(z.string()).optional(),
        assets: z.array(z.string()).optional(),
      }),
    )
    .parse(JSON.parse(readFileSync(join(dist, ".vite/manifest.json"), "utf8")));
  const required = new Set([
    "index.html",
    ".vite/manifest.json",
    ...Object.values(manifest).flatMap((item) => [
      item.file,
      ...(item.css ?? []),
      ...(item.assets ?? []),
    ]),
  ]);
  assert.equal(profileReleaseReadiness(root, "release:host").ready, true);
  for (const file of required) {
    const path = join(dist, file);
    const held = `${path}.acceptance-held`;
    renameSync(path, held);
    try {
      const result = profileReleaseReadiness(root, "release:host");
      assert.equal(result.ready, false, file);
      assert.equal(result.reason, "dashboard-assets-or-catalog-revision");
      assert.match(result.remedy, /including .vite\/manifest.json/);
    } finally {
      renameSync(held, path);
    }
    assert.equal(profileReleaseReadiness(root, "release:host").ready, true, file);
  }
  console.log(
    `Packaging: ${String(files.length)} original files match; all ${String(required.size)} graph artifacts independently required, including hidden manifest`,
  );
}
