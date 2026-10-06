import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { join } from "node:path";

import { compileExecutable } from "./compile-executable.js";

/** Compiles the admin, host and operations executables into the installation root. */
export function compileInstallationExecutables(root: string) {
  const binaries = {
    admin: join(root, "marea-admin"),
    host: join(root, "marea-teacher"),
    operations: join(root, "marea-operations"),
  };
  compileExecutable("cli-entry.ts", binaries.admin);
  compileExecutable("teacher-host-entry.ts", binaries.host);
  compileExecutable("operations-entry.ts", binaries.operations);
  return binaries;
}

/** Starts a compiled `marea-teacher` and resolves once it reports readiness. */
export async function startCompiledHost(
  binary: string,
  root: string,
  releaseId: string,
  extra: readonly string[] = [],
) {
  const child = spawn(binary, ["--installation", root, "--release", releaseId, ...extra], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.on("data", (chunk: Buffer) => {
    output.stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    output.stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
    child.on("exit", (code, signal) => {
      resolve({ code, signal });
    });
  });
  const deadline = Date.now() + 30_000;
  while (!output.stdout.includes("Teacher host ready at ") && Date.now() < deadline)
    await Bun.sleep(50);
  const origin = /Teacher host ready at (http:\/\/(?:127\.0\.0\.1|0\.0\.0\.0):\d+)/u.exec(
    output.stdout,
  )?.[1];
  assert.ok(origin, `host did not report readiness: ${output.stderr}`);
  return { child, exited, origin, output };
}

/** Signals the host to drain and asserts a clean exit. */
export async function stopCompiledHost(host: Awaited<ReturnType<typeof startCompiledHost>>) {
  host.child.kill("SIGTERM");
  assert.deepEqual(await host.exited, { code: 0, signal: null }, host.output.stderr);
}

/**
 * Runs an executable on a pseudo-terminal and types one answer per abandoned lock question, in
 * order. Input ends only after the last decision, so end of input cannot race a typed answer.
 */
export async function answeringLockQuestions(
  binary: string,
  root: string,
  args: readonly string[],
  answers: readonly string[],
) {
  // `script` needs a pipe rather than the socket Node creates, so `cat` relays the answers.
  const child = spawn(
    "sh",
    ["-c", 'cat | script -q /dev/null "$@"', "sh", binary, "--installation", root, ...args],
    { stdio: ["pipe", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => {
    const asked = output.split("[y/N] ").length;
    output += chunk.toString("utf8");
    for (let question = asked; question < output.split("[y/N] ").length; question += 1)
      child.stdin.write(`${answers[question - 1] ?? ""}\n`);
    if (output.split("The lock was").length > answers.length) child.stdin.end();
  });
  const code = await new Promise<number | null>((resolve) => {
    child.on("exit", resolve);
  });
  return { code, output: output.replaceAll("\r\n", "\n") };
}
