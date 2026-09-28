/* global process, console */
import { spawnSync } from "node:child_process";
import { mkdirSync, openSync, closeSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";

// Run every unchanged gate even after failure. Coverage and mutation are strictly serial.
const root = resolve(import.meta.dirname, "../../..");
const output = resolve(process.argv[2] ?? "/tmp/marea-release-quality");
mkdirSync(output, { recursive: true });
const runner = readFileSync(join(root, "scripts/run-mutation-suite.mjs"), "utf8");
const scopes = [
  ".",
  ...Array.from(runner.matchAll(/"((?:apps|packages|plugins)\/[^"\n]+)"/g), (m) => m[1]),
];
if (scopes.length !== 17) throw new Error("Review the mutation scope inventory before running");
const results = [];
function run(name, args, cwd = root) {
  const log = join(output, `${name}.log`);
  const fd = openSync(log, "w");
  const started = new Date();
  console.log(`${started.toISOString()} START ${name}`);
  const result = spawnSync("bun", args, { cwd, stdio: ["ignore", fd, fd] });
  closeSync(fd);
  results.push({
    name,
    command: ["bun", ...args],
    cwd,
    started: started.toISOString(),
    seconds: (Date.now() - started.getTime()) / 1000,
    status: result.status,
    signal: result.signal,
    error: result.error?.message,
    log,
  });
  writeFileSync(join(output, "results.json"), JSON.stringify(results, null, 2) + "\n");
  console.log(`END ${name}: ${result.status} (${results.at(-1).seconds}s)`);
}
for (const gate of [
  "format:check",
  "catalog:check",
  "lint",
  "typecheck",
  "compatibility:bun",
  "architecture",
  "dead-code",
  "duplicates",
  "metrics:halstead",
])
  run(gate.replaceAll(":", "-"), ["run", gate]);
run("coverage", ["run", "test:coverage", "--maxWorkers=2"]);
for (const scope of scopes)
  run(
    `mutation-${scope === "." ? "root" : scope.replaceAll("/", "-")}`,
    [
      "x",
      "stryker",
      "run",
      "stryker.config.mjs",
      "--concurrency",
      "2",
      "--reporters",
      "clear-text,json,progress",
    ],
    resolve(root, scope),
  );
process.exitCode = results.every((result) => result.status === 0) ? 0 : 1;
