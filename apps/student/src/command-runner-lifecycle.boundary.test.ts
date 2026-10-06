import { ChildProcess, spawn, spawnSync } from "node:child_process";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runProjectCommand } from "./command-runner.boundary.js";
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  spawn: vi.fn(),
  spawnSync: vi.fn(),
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
      windowsHide: true,
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

it.each([0, 1])(
  "uses the Windows command processor and terminates its tree (status %s)",
  async (status) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.stubEnv("SystemRoot", "D:\\Windows");
    vi.mocked(spawnSync).mockReturnValue({
      status,
      signal: null,
      pid: 99,
      output: [],
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    try {
      const f = fixture();
      expect(spawn).toHaveBeenLastCalledWith(
        "D:\\Windows\\System32\\cmd.exe",
        ["/d", "/s", "/c", "synthetic command"],
        {
          cwd: "/synthetic",
          detached: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      f.abort.abort();
      expect(spawnSync).toHaveBeenLastCalledWith(
        "D:\\Windows\\System32\\taskkill.exe",
        ["/pid", "42", "/T", "/F"],
        { stdio: "ignore", windowsHide: true, timeout: 5000 },
      );
      expect(f.group).not.toHaveBeenCalled();
      if (status === 0) expect(f.kill).not.toHaveBeenCalled();
      else expect(f.kill).toHaveBeenCalledWith("SIGTERM");
      f.child.emit("close", 1);
      expect(JSON.parse(await f.running)).toMatchObject({ stopped: true, exitCode: 1 });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

it("uses the standard Windows directory when the environment is absent and falls back if taskkill cannot start", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  vi.stubEnv("SystemRoot", undefined);
  vi.mocked(spawnSync).mockImplementation(() => {
    throw new Error("taskkill unavailable");
  });
  try {
    const f = fixture();
    expect(vi.mocked(spawn).mock.calls.at(-1)?.[0]).toBe("C:\\Windows\\System32\\cmd.exe");
    f.abort.abort();
    expect(vi.mocked(spawnSync).mock.calls.at(-1)?.[0]).toBe("C:\\Windows\\System32\\taskkill.exe");
    expect(f.kill).toHaveBeenCalledWith("SIGTERM");
    f.child.emit("close", null);
    expect(JSON.parse(await f.running)).toMatchObject({ stopped: true });
  } finally {
    vi.unstubAllEnvs();
  }
});
