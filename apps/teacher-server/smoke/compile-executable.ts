import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync } from "node:fs";

/** Compiles one executable entry with Bun into a private file, failing the rehearsal on error. */
export function compileExecutable(entry: string, outfile: string): void {
  const result = spawnSync("bun", ["build", entry, "--compile", "--outfile", outfile], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.status, 0, result.stderr);
  chmodSync(outfile, 0o700);
}
