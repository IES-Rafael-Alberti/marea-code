/* global Bun, console */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const expectedBun = JSON.parse(readFileSync("package.json", "utf8")).engines.bun;
assert.equal(Bun.version, expectedBun);
assert.equal(spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim(), expectedBun);
const root = resolve("reports/resilience/recovery");
mkdirSync(root, { recursive: true });
const steps = [
  "compiled-interruption",
  "compiled-operations",
  "compiled-rollback",
  "compiled-transfer",
  "compiled-inference-recovery",
  "compiled-telemetry",
];
const receipts = [];
const start = Date.now();
for (const name of steps) {
  const started = Date.now();
  const result = spawnSync("bun", ["run", `smoke/${name}.ts`], {
    cwd: resolve("apps/teacher-server"),
    encoding: "utf8",
    timeout: 300000,
  });
  const log = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  writeFileSync(join(root, `${name}.log`), log);
  receipts.push({
    command: `cd apps/teacher-server && bun run smoke/${name}.ts`,
    status: result.status,
    signal: result.signal,
    durationMs: Date.now() - started,
    logSha256: createHash("sha256").update(log).digest("hex"),
  });
  console.log(JSON.stringify(receipts.at(-1)));
}
const build = mkdtempSync(join(tmpdir(), "marea-resilience-quota-"));
try {
  for (const probe of ["disk-full", "backpressure"]) {
    const started = Date.now();
    const binary = join(build, probe);
    const compiled = spawnSync(
      "bun",
      ["build", `tests/resilience/${probe}.mjs`, "--compile", "--outfile", binary],
      { encoding: "utf8" },
    );
    assert.equal(compiled.status, 0, compiled.stderr);
    const result = spawnSync(binary, [], { encoding: "utf8", timeout: 30000 });
    const log = `${result.stdout}\n${result.stderr}`;
    writeFileSync(join(root, `${probe}.log`), log);
    receipts.push({
      command: `bun build tests/resilience/${probe}.mjs --compile --outfile <disposable>/${probe} && <disposable>/${probe}`,
      status: result.status,
      durationMs: Date.now() - started,
      logSha256: createHash("sha256").update(log).digest("hex"),
      binarySha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
    });
  }
} finally {
  rmSync(build, { recursive: true, force: true });
}
const summary = {
  runtime: Bun.version,
  sourceCommit: spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim(),
  durationMs: Date.now() - start,
  receipts,
  allPassed: receipts.every((receipt) => receipt.status === 0),
  boundary:
    "Compiled synthetic recovery rehearsals; aggregate includes build time; full installation restore is separately measured by campaign",
};
writeFileSync(join(root, "receipt.json"), JSON.stringify(summary, null, 2));
assert.ok(summary.allPassed, "See durable per-scenario logs");
