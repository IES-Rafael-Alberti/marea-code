import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { compileExecutable } from "./compile-executable.js";

/** Schema expected by the external previous-release source fixture. */
export const PREVIOUS_RELEASE = { schemaVersion: 8 } as const;

function run(command: string, args: readonly string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    timeout: 300_000,
    maxBuffer: 256 * 1024 * 1024,
  });
  assert.equal(result.status, 0, `${command} ${args.join(" ")}: ${result.stderr}`);
}

/** Rebuilds a schema-8 release supplied through MAREA_PREVIOUS_RELEASE_SOURCE. */
export function buildPreviousAdmin(workspace: string): string {
  const supplied = process.env.MAREA_PREVIOUS_RELEASE_SOURCE;
  assert.ok(
    supplied,
    "Set MAREA_PREVIOUS_RELEASE_SOURCE to a schema-8 release source directory to run the rollback smoke test.",
  );
  const previousSource = resolve(supplied);
  assert.ok(
    existsSync(join(previousSource, "bun.lock")),
    "Previous release requires its frozen bun.lock",
  );
  assert.ok(
    existsSync(join(previousSource, "apps", "teacher-server", "cli-entry.ts")),
    "Previous release requires the administrator CLI entrypoint",
  );
  const source = join(workspace, "source");
  cpSync(previousSource, source, {
    recursive: true,
    filter: (path) => ![".git", "node_modules", "dist"].includes(path.split(/[\\/]/u).at(-1) ?? ""),
  });
  run("bun", ["install", "--frozen-lockfile"], source);
  const binary = join(workspace, "marea-admin-previous");
  compileExecutable(join(source, "apps", "teacher-server", "cli-entry.ts"), binary);
  return binary;
}
