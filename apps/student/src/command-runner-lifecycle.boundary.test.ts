import { ChildProcess, spawn } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runProjectCommand } from "./command-runner.boundary.js";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
}));
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function fixture(pid: number | undefined = 42) {
  vi.useFakeTimers();
  const kill = vi.fn().mockReturnValue(true);
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.defineProperties(new ChildProcess(), {
    pid: { value: pid, writable: true },
    stdout: { value: stdout },
    stderr: { value: stderr },
    kill: { value: kill },
  });
  vi.mocked(spawn).mockReturnValue(child);
  const group = vi.spyOn(process, "kill").mockReturnValue(true);
  const abort = new AbortController();
  const add = vi.spyOn(abort.signal, "addEventListener");
  const remove = vi.spyOn(abort.signal, "removeEventListener");
  const running = runProjectCommand("/synthetic", "synthetic command", abort.signal);
  return { child, stdout, stderr, kill, group, abort, add, remove, running };
}
it.each([16384, 16385])(
  "bounds %s characters across multiple stdout/stderr chunks",
  async (size) => {
    const f = fixture();
    expect(spawn).toHaveBeenLastCalledWith("/bin/sh", ["-c", "synthetic command"], {
      cwd: "/synthetic",
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    f.stdout.write(Buffer.from("first "));
    f.stderr.write(Buffer.from("x".repeat(size - 6)));
    f.child.emit("close", 7);
    expect(JSON.parse(await f.running)).toEqual({
      exitCode: 7,
      stopped: false,
      truncated: size > 16384,
      output: `first ${"x".repeat(16378)}`,
    });
    expect(f.group).toHaveBeenCalledWith(-42, "SIGKILL");
    expect(f.add).toHaveBeenCalledWith("abort", expect.any(Function), { once: true });
    expect(f.remove).toHaveBeenCalledWith("abort", expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    f.abort.abort();
    expect(f.group).toHaveBeenCalledTimes(1);
  },
);
it("falls back to the child handle and removes deadline/escalation after close", async () => {
  const f = fixture();
  f.group.mockImplementation(() => {
    throw new Error("group unavailable");
  });
  f.abort.abort();
  expect(f.kill).toHaveBeenCalledWith("SIGTERM");
  expect(vi.getTimerCount()).toBe(2);
  f.child.emit("close", null);
  expect(f.kill).toHaveBeenLastCalledWith("SIGKILL");
  expect(JSON.parse(await f.running)).toMatchObject({ stopped: true });
  expect(vi.getTimerCount()).toBe(0);
});
it("cleans cancellation and timers when spawning fails without a pid", async () => {
  const f = fixture();
  Reflect.set(f.child, "pid", undefined);
  f.abort.abort();
  expect(f.group).not.toHaveBeenCalled();
  expect(f.kill).not.toHaveBeenCalled();
  const error = new Error("spawn failed");
  f.child.emit("error", error);
  await expect(f.running).rejects.toBe(error);
  expect(f.remove).toHaveBeenCalledWith("abort", expect.any(Function));
  expect(vi.getTimerCount()).toBe(0);
});

it("decodes split UTF-8 independently on both streams and flushes incomplete final sequences", async () => {
  const f = fixture();
  f.stdout.write(Buffer.from([0xe2, 0x82]));
  f.stderr.write(Buffer.from([0xc3]));
  f.stdout.write(Buffer.from([0xac]));
  f.stderr.write(Buffer.from([0xa9]));
  f.stdout.write(Buffer.from([0xe2]));
  f.stderr.write(Buffer.from([0xc3]));
  f.child.emit("close", 0);
  expect(JSON.parse(await f.running)).toMatchObject({ output: "€é��", truncated: false });
});
