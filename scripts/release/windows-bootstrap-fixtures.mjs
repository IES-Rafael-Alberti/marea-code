import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";

// Build as CI, then give the standard user only the resulting test artifacts.
// End users do not need access to CI's source tree or Bun dependency cache.
const root = resolve(process.argv[2]);
function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120_000 });
  assert.equal(result.status, 0, result.stdout + result.stderr);
}
function executable(entry, binary) {
  run(process.execPath, ["build", entry, "--compile", "--minify", "--outfile", binary]);
  run("powershell.exe", [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("scripts/release/windows-executable-manifest.ps1"),
    "-Executable",
    binary,
  ]);
}
const entry = join(root, "installer.mjs");
writeFileSync(
  entry,
  `import {writeFileSync} from 'node:fs';
await Bun.sleep(600);
writeFileSync(process.env.MAREA_BOOTSTRAP_RECEIPT, JSON.stringify({architecture:process.arch,args:process.argv.slice(2)}));
process.exit(Number(process.env.MAREA_BOOTSTRAP_EXIT || 0));`,
);
executable(entry, join(root, "installer.exe"));
const managed = join(root, "managed");
mkdirSync(managed);
executable("scripts/release/install.mjs", join(managed, "marea-install.exe"));
writeFileSync(
  join(managed, "manifest.json"),
  JSON.stringify({ component: "student", version: "0.1.0-preview.1" }),
);
for (const [source, target] of [
  ["windows-bootstrap-smoke", "smoke"],
  ["preview-launcher-smoke", "managed-smoke"],
]) {
  run(process.execPath, [
    "build",
    `scripts/release/${source}.mjs`,
    "--target=bun",
    "--outfile",
    join(root, `${target}.mjs`),
  ]);
}
