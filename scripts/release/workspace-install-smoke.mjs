import process from "node:process";
import console from "node:console";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCommand } from "./build-command.ts";
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
  const [binary, args] = buildCommand([
    "bun",
    "install",
    "--frozen-lockfile",
    "--ignore-scripts",
    "--backend",
    "copyfile",
  ]);
  const install = spawnSync(binary, args, { cwd: workspace, encoding: "utf8" });
  if (install.status !== 0) console.error(install.stderr);
  assert.equal(
    install.status,
    0,
    "Isolated native dependencies must install with the committed lockfile",
  );
  assert.deepEqual(readFileSync(join(workspace, "bun.lock")), locked);
});
console.log("Isolated frozen dependency installation passed.");
