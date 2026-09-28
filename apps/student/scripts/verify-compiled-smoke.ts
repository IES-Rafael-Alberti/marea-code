import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const packageRoot = resolve(import.meta.dir, "..");
const temporaryDirectory = mkdtempSync(resolve(tmpdir(), "marea-student-compiled-"));
const executablePath = resolve(temporaryDirectory, "marea");

function run(
  command: readonly string[],
  environment = process.env,
): { readonly exitCode: number; readonly stderr: string; readonly stdout: string } {
  const result = Bun.spawnSync([...command], {
    cwd: packageRoot,
    env: environment,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function requireResult(
  result: ReturnType<typeof run>,
  expectedExitCode: number,
  expectedOutput: string,
): void {
  if (
    result.exitCode !== expectedExitCode ||
    !`${result.stdout}${result.stderr}`.includes(expectedOutput)
  ) {
    throw new Error("The compiled student command returned an unexpected result.");
  }
}

try {
  requireResult(
    run([
      "bun",
      "build",
      "./src/marea-entry.boundary.ts",
      "--compile",
      "--outfile",
      executablePath,
    ]),
    0,
    "compile",
  );
  const environment = { ...process.env, LANG: "en-US", MAREA_SERVER_URL: "" };
  requireResult(run([executablePath, "--version"], environment), 0, "0.2.0");
  requireResult(run([executablePath, "--help"], environment), 0, "Usage: marea");
  requireResult(
    run([executablePath], environment),
    1,
    "Marea does not have a teacher server address yet.",
  );
  process.stdout.write("Compiled marea student command smoke test passed.\n");
} finally {
  rmSync(temporaryDirectory, { force: true, recursive: true });
}
