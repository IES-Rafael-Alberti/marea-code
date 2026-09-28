import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/** Capture tracked AND untracked build inputs before compilation, including shared fixtures. */
export function captureSource(report) {
  const paths = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      "apps",
      "packages",
      "plugins",
      "test-support",
      "package.json",
      "bun.lock",
      "tsconfig.json",
      "tsconfig.bun.json",
    ],
    { encoding: "utf8", maxBuffer: 16000000 },
  );
  assert.equal(paths.status, 0, paths.stderr);
  const manifest = paths.stdout
    .split("\0")
    .filter((path) => path && existsSync(path))
    .sort()
    .map((path) => {
      const digest = sha256(readFileSync(path));
      const destination = join(`${report}.source-tree`, path);
      mkdirSync(dirname(destination), { recursive: true });
      cpSync(path, destination);
      return { path, sha256: digest };
    });
  const text = JSON.stringify(manifest, null, 2);
  writeFileSync(`${report}.source-manifest.json`, text);
  return {
    sha256: sha256(text),
    files: manifest.length,
    assertUnchanged: () => {
      for (const file of manifest.filter(
        ({ path }) =>
          !/\.test\.[cm]?[jt]sx?$/u.test(path) &&
          !path.startsWith("apps/student/") &&
          !path.startsWith("apps/dashboard/"),
      ))
        assert.equal(
          sha256(readFileSync(file.path)),
          file.sha256,
          `Source changed during compilation: ${file.path}`,
        );
    },
  };
}
