import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";

import { Glob } from "bun";

const repositoryRoot = resolve(import.meta.dirname, "..");
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

// Each Vitest workspace already runs workers; avoid multiplying pools across packages.
for (const pattern of manifest.workspaces) {
  const packages = new Glob(`${pattern}/package.json`).scanSync({ cwd: repositoryRoot });
  for (const packagePath of [...packages].sort()) {
    const result = spawnSync("bun", ["run", "--if-present", "test:bun"], {
      cwd: dirname(resolve(repositoryRoot, packagePath)),
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}
