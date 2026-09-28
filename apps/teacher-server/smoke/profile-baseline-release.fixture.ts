import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";
import { compileExecutable } from "./compile-executable.js";

function run(command: string, args: string[], cwd: string, input?: Buffer) {
  const result = spawnSync(command, args, {
    cwd,
    input,
    encoding: "utf8",
    timeout: 120_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
}

/** Rebuild the required schema-9 baseline in a disposable archive, reusing installed dependencies. */
export function buildProfileBaseline(workspace: string) {
  const repository = resolve(import.meta.dir, "../../..");
  const source = join(workspace, "baseline-source");
  mkdirSync(source, { mode: 0o700 });
  const archive = join(workspace, "baseline.tar");
  run("git", ["archive", "--format=tar", `--output=${archive}`, "752647b"], repository);
  run("tar", ["-xf", archive, "-C", source], repository);
  rmSync(archive);
  const linkDependencies = (relative: string) => {
    const from = join(repository, relative, "node_modules");
    if (!existsSync(from)) return;
    const to = join(source, relative, "node_modules");
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from)) {
      if (entry === "@marea" || [".cache", ".vite", ".vite-temp"].includes(entry)) continue;
      symlinkSync(join(from, entry), join(to, entry));
    }
  };
  linkDependencies("");
  mkdirSync(join(source, "node_modules", "@marea"));
  // Every workspace dependency resolves to the archive; external packages are reused read-only.
  const rootManifest = z
    .object({ workspaces: z.array(z.string()) })
    .parse(JSON.parse(readFileSync(join(source, "package.json"), "utf8")));
  for (const pattern of rootManifest.workspaces) {
    for (const manifest of new Bun.Glob(`${pattern}/package.json`).scanSync({ cwd: source })) {
      const { name } = z
        .object({ name: z.string().startsWith("@marea/") })
        .parse(JSON.parse(readFileSync(join(source, manifest), "utf8")));
      symlinkSync(join(source, dirname(manifest)), join(source, "node_modules", name));
      linkDependencies(dirname(manifest));
    }
  }
  run("bun", ["run", "build"], join(source, "apps/dashboard"));
  const host = join(workspace, "baseline-teacher");
  const operations = join(workspace, "baseline-operations");
  compileExecutable(join(source, "apps/teacher-server/teacher-host-entry.ts"), host);
  compileExecutable(join(source, "apps/teacher-server/operations-entry.ts"), operations);
  return { host, operations, dashboard: join(source, "apps/dashboard/dist") };
}
