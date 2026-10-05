import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { sha256 } from "./manifest.ts";
import { withBuildWorkspace } from "./workspace.boundary.ts";

const listed = spawnSync("git", ["ls-files", "--cached", "-z"], { encoding: "utf8" });
assert.equal(listed.status, 0);
const files = listed.stdout
  .split("\0")
  .filter(Boolean)
  .map((path) => ({
    path,
    sha256: existsSync(path) ? sha256(readFileSync(path)) : null,
  }));
withBuildWorkspace(process.cwd(), files, (workspace) => {
  const locked = readFileSync(join(workspace, "bun.lock"));
  const install = spawnSync(
    process.execPath,
    ["install", "--frozen-lockfile", "--ignore-scripts", "--backend", "copyfile"],
    { cwd: workspace, encoding: "utf8" },
  );
  if (install.status !== 0) {
    console.error(install.stderr);
    // Diagnose only inside this disposable copy; never use a changed lockfile to build a release.
    const diagnostic = spawnSync(
      process.execPath,
      ["install", "--lockfile-only", "--ignore-scripts"],
      {
        cwd: workspace,
        encoding: "utf8",
      },
    );
    console.error(diagnostic.stderr);
    writeFileSync(join(workspace, "bun.lock.before"), locked);
    const diff = spawnSync("git", ["diff", "--no-index", "--", "bun.lock.before", "bun.lock"], {
      cwd: workspace,
      encoding: "utf8",
    });
    console.error(diff.stdout);
  }
  assert.equal(
    install.status,
    0,
    "Isolated native dependencies must install with the committed lockfile",
  );
  assert.deepEqual(readFileSync(join(workspace, "bun.lock")), locked);
});
console.log("Isolated frozen dependency installation passed.");
