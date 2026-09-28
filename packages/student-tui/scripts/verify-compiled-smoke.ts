import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { SMOKE_OUTPUT } from "../src/smoke.js";

const packageRoot = resolve(import.meta.dirname, "..");
const outputDirectory = resolve(packageRoot, "dist");
const executable = resolve(outputDirectory, "marea-student-tui");

await rm(outputDirectory, { force: true, recursive: true });
await mkdir(outputDirectory, { recursive: true });

const build = Bun.spawn(
  ["bun", "build", "./scripts/entry.ts", "--compile", "--outfile", executable],
  { cwd: packageRoot, stderr: "pipe", stdout: "pipe" },
);
const buildExitCode = await build.exited;
if (buildExitCode !== 0)
  throw new Error(`Compiled smoke build failed with exit code ${String(buildExitCode)}.`);

const smoke = Bun.spawn([executable, "--smoke"], {
  cwd: packageRoot,
  env: { PATH: process.env.PATH ?? "" },
  stderr: "pipe",
  stdout: "pipe",
});
const smokeExitCode = await smoke.exited;
const stdout = await new Response(smoke.stdout).text();
const stderr = await new Response(smoke.stderr).text();

if (smokeExitCode !== 0)
  throw new Error(`Compiled smoke exited with code ${String(smokeExitCode)}.`);
if (stderr.length !== 0) throw new Error("Compiled smoke wrote to stderr.");
if (stdout !== `${SMOKE_OUTPUT}: complete/ok\n`)
  throw new Error("Compiled smoke output was not deterministic.");

const parserExecutable = resolve(outputDirectory, "marea-parser-smoke");
const parserBuild = Bun.spawn(
  ["bun", "build", "./scripts/parser-smoke.ts", "--compile", "--outfile", parserExecutable],
  {
    cwd: packageRoot,
    stdout: "pipe",
    stderr: "pipe",
  },
);
if ((await parserBuild.exited) !== 0) throw new Error("Compiled parser build failed.");
const parserHome = await mkdtemp(resolve(tmpdir(), "marea-parser-smoke-"));
try {
  const parser = Bun.spawn([parserExecutable], {
    cwd: parserHome,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: parserHome,
      XDG_DATA_HOME: parserHome,
      XDG_CACHE_HOME: parserHome,
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, output, errors] = await Promise.all([
    parser.exited,
    new Response(parser.stdout).text(),
    new Response(parser.stderr).text(),
  ]);
  if (status !== 0 || errors.length !== 0 || output !== "Compiled Markdown parser: pass\n")
    throw new Error(`Compiled parser failed: ${output}${errors}`);
} finally {
  await rm(parserHome, { recursive: true, force: true });
}

await rm(outputDirectory, { force: true, recursive: true });
process.stdout.write(`${SMOKE_OUTPUT}\n`);
