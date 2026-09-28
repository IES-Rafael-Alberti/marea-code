import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, watch } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

// Python supplies only a real POSIX terminal, not application behavior or mocked ports.
const terminalDriver = String.raw`
import errno, json, os, pty, select, signal, sys, time
spec = json.load(sys.stdin)
pid, fd = pty.fork()
if pid == 0:
    os.chdir(spec["root"])
    os.execv(spec["binary"], [spec["binary"], "--installation", spec["root"], "credential", "provision", "--user", spec["user"], "--expected-version", spec["version"]])
transcript = bytearray()
sent = False
status = None
deadline = time.monotonic() + 15
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([fd], [], [], 0.02)
        if ready:
            try:
                chunk = os.read(fd, 4096)
            except OSError as error:
                if error.errno != errno.EIO:
                    raise
                chunk = b""
            transcript.extend(chunk)
            if len(transcript) > 16384:
                raise RuntimeError("unbounded terminal output")
            if not sent and b"Password: " in transcript:
                os.write(fd, (spec["password"] + spec["ending"]).encode("utf-8"))
                sent = True
        done, result = os.waitpid(pid, os.WNOHANG)
        if done:
            status = os.waitstatus_to_exitcode(result)
            break
    if status is None:
        raise RuntimeError("terminal command timed out")
    # Drain any output emitted just before exit.
    while select.select([fd], [], [], 0)[0]:
        try:
            chunk = os.read(fd, 4096)
        except OSError as error:
            if error.errno != errno.EIO:
                raise
            break
        if not chunk:
            break
        transcript.extend(chunk)
    print(json.dumps({"status": status, "transcript": transcript.decode("utf-8", "strict")}))
finally:
    if status is None:
        os.kill(pid, signal.SIGKILL)
        os.waitpid(pid, 0)
    os.close(fd)
`;

export function terminalCredential(input: {
  readonly binary: string;
  readonly root: string;
  readonly user: string;
  readonly version: string;
  readonly password: string;
  readonly ending: "\r" | "\x03" | "\x04";
}) {
  const result = spawnSync("python3", ["-c", terminalDriver], {
    input: JSON.stringify(input),
    encoding: "utf8",
    timeout: 20_000,
    maxBuffer: 65_536,
  });
  assert.equal(result.status, 0, result.stderr);
  const output = z
    .object({ status: z.number().int(), transcript: z.string() })
    .strict()
    .parse(JSON.parse(result.stdout));
  assert.ok(!output.transcript.includes(input.password), "password must never be echoed");
  assert.ok(output.transcript.startsWith("Password: "), "real non-echoing prompt is required");
  assert.equal(existsSync(join(input.root, "locks/installation.lock")), false);
  return { ...output, transcript: output.transcript.replaceAll("\r\n", "\n") };
}

export function interruptCredential(binary: string, root: string, version: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const lock = join(root, "locks/installation.lock");
    let signaled = false;
    let stdout = "";
    let stderr = "";
    const observer = watch(join(root, "locks"), () => {
      if (!signaled && existsSync(lock)) {
        signaled = true;
        child.kill("SIGTERM");
      }
    });
    const child = spawn(
      binary,
      [
        "--installation",
        root,
        "credential",
        "provision",
        "--user",
        "user:teacher",
        "--expected-version",
        version,
        "--password-stdin",
      ],
      { cwd: root, stdio: ["pipe", "pipe", "pipe"] },
    );
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
    }, 10_000);
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString("utf8");
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.stdin.on("error", () => undefined);
    child.stdin.write("unfinished-private-password");
    child.once("error", reject);
    child.once("close", (code) => {
      clearTimeout(timeout);
      observer.close();
      try {
        assert.equal(signaled, true);
        assert.equal(code, 143);
        assert.equal(stdout, "");
        assert.equal(stderr, "Operator command terminated; verify its outcome.\n");
        assert.equal(existsSync(lock), false);
        resolve();
      } catch (error) {
        reject(new Error("Compiled interruption assertions failed", { cause: error }));
      }
    });
  });
}

export function brokenOutput(binary: string, root: string, args: string[]): void {
  const driver = String.raw`
import json, os, subprocess, sys
spec = json.load(sys.stdin)
reader, writer = os.pipe()
os.close(reader)
try:
    result = subprocess.run([spec["binary"], *spec["args"]], cwd=spec["root"], stdin=subprocess.DEVNULL, stdout=writer, stderr=subprocess.PIPE, timeout=15)
    print(json.dumps({"status": result.returncode, "stderr": result.stderr.decode("utf-8")}))
finally:
    os.close(writer)
`;
  const result = spawnSync("python3", ["-c", driver], {
    input: JSON.stringify({ binary, root, args }),
    encoding: "utf8",
    timeout: 20_000,
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), {
    status: 6,
    stderr: "Operator command failed or its outcome is uncertain.\n",
  });
  assert.equal(existsSync(join(root, "locks/installation.lock")), false);
}
