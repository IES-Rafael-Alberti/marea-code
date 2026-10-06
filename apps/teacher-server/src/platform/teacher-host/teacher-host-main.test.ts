import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  start: vi.fn(),
  serve: vi.fn(),
  passwords: { hash: vi.fn(), verify: vi.fn() },
  offer: vi.fn(),
  recovery: {
    terminal: { interactive: false, write: vi.fn(), readLine: vi.fn() },
    processExists: vi.fn(),
  },
}));
vi.mock("../installation/abandoned-lock-recovery.js", () => ({
  offerAbandonedLockRemoval: mocks.offer,
}));
vi.mock("../installation/lock-recovery-terminal.boundary.js", () => ({
  processLockRecovery: () => mocks.recovery,
}));
vi.mock("./teacher-host.js", () => ({ startTeacherHost: mocks.start }));
vi.mock("./bun-serve.boundary.js", () => ({ bunServe: mocks.serve }));
vi.mock("../../identity/password-hasher.boundary.js", () => ({
  bunArgon2idPasswordHasher: mocks.passwords,
}));

import type { TeacherHostOptions } from "./teacher-host.js";

import { parseHostArguments, runTeacherHost, runTeacherHostMain } from "./teacher-host-main.js";

afterEach(() => {
  vi.clearAllMocks();
});

vi.mock("./http-access.boundary.js", async (original) => ({
  ...(await original<typeof import("./http-access.boundary.js")>()),
  localHttpHosts: () => ["localhost", "192.168.1.20"],
}));

const ARGV = ["--installation", "/private/root", "--release", "release:one"];

function dependencies() {
  const signals = new EventEmitter();
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    signals,
    stdout,
    stderr,
    ports: {
      serve: mocks.serve,
      signals,
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
      passwords: mocks.passwords,
      lockRecovery: mocks.recovery,
    },
  };
}

describe("teacher host executable", () => {
  it("accepts only the installation and release arguments", () => {
    expect(parseHostArguments(ARGV)).toEqual({
      root: "/private/root",
      releaseId: "release:one",
      allowHttp: false,
    });
    for (const argv of [
      [],
      ["--installation", "/private/root"],
      ["--release", "/private/root", "--installation", "release:one"],
      ["--installation", "/private/root", "--version", "release:one"],
      [...ARGV, "--extra"],
      ["--other", "/private/root", "--release", "release:one"],
      ["--installation", "/private/root", "--release"],
    ])
      expect(parseHostArguments(argv)).toBeUndefined();
  });

  it("enables HTTP only for an explicit startup flag and prints connection URLs", async () => {
    expect(parseHostArguments([...ARGV, "--allow-http"])).toEqual({
      root: "/private/root",
      releaseId: "release:one",
      allowHttp: true,
    });
    expect(parseHostArguments([...ARGV, "--allow-http", "--allow-http"])).toBeUndefined();
    const deps = dependencies();
    const stop = vi.fn(() => Promise.resolve({ state: "stopped", reasonCode: "stopped" }));
    mocks.start.mockResolvedValueOnce({ state: "ready", url: "http://0.0.0.0:18787", stop });
    const running = runTeacherHost([...ARGV, "--allow-http"], deps.ports);
    await vi.waitFor(() => {
      expect(deps.stdout).toContain(
        "Student connection: marea --server http://192.168.1.20:18787\n",
      );
    });
    expect(deps.stdout).toContain("Student connection: marea --server http://localhost:18787\n");
    expect(deps.stderr).toEqual([
      "HTTP LAN mode: listening on all IPv4 interfaces without transport encryption.\n",
    ]);
    expect(mocks.start.mock.calls[0]?.[0]).toMatchObject({
      httpHosts: ["localhost", "192.168.1.20"],
    });
    deps.signals.emit("SIGINT");
    expect(await running).toBe(0);
    expect(stop).toHaveBeenCalledOnce();
  });

  it("maps start failures to exit classes without serving", async () => {
    const usage = dependencies();
    expect(await runTeacherHost([], usage.ports)).toBe(2);
    expect(usage.stderr).toEqual([
      "Usage: marea-teacher --installation <root> --release <id> [--allow-http]\n",
    ]);
    for (const [reason, code] of [
      ["lock", 3],
      ["config", 5],
      ["release", 5],
      ["storage", 5],
      ["recovery", 5],
      ["index", 5],
      ["assets", 5],
      ["listen", 5],
    ] as const) {
      const failed = dependencies();
      mocks.start.mockResolvedValueOnce({ state: "failed", reason });
      expect(await runTeacherHost(ARGV, failed.ports)).toBe(code);
      expect(failed.stderr).toEqual([`Teacher host did not start: ${reason}.\n`]);
      expect(failed.stdout).toEqual([]);
      expect(["SIGINT", "SIGTERM"].map((signal) => failed.signals.listenerCount(signal))).toEqual([
        0, 0,
      ]);
    }
  });

  it("offers abandoned lock removal once and starts again only when the lock was removed", async () => {
    const kept = dependencies();
    mocks.start.mockResolvedValueOnce({ state: "failed", reason: "lock" });
    mocks.offer.mockResolvedValueOnce(false);
    expect(await runTeacherHost(ARGV, kept.ports)).toBe(3);
    expect(mocks.offer).toHaveBeenCalledWith("/private/root", mocks.recovery);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    const removed = dependencies();
    mocks.start
      .mockResolvedValueOnce({ state: "failed", reason: "lock" })
      .mockResolvedValueOnce({ state: "failed", reason: "index" });
    mocks.offer.mockResolvedValueOnce(true);
    expect(await runTeacherHost(ARGV, removed.ports)).toBe(5);
    expect(mocks.start).toHaveBeenCalledTimes(3);
    expect(mocks.start.mock.calls[2]?.[0]).toMatchObject({
      installationRoot: "/private/root",
      releaseId: "release:one",
      serve: mocks.serve,
      passwords: mocks.passwords,
    });
    expect(removed.stderr).toEqual(["Teacher host did not start: index.\n"]);

    const other = dependencies();
    mocks.start.mockResolvedValueOnce({ state: "failed", reason: "config" });
    expect(await runTeacherHost(ARGV, other.ports)).toBe(5);
    // Only a failed start is a lock refusal, whatever else the result carries.
    const ready = dependencies();
    mocks.start.mockResolvedValueOnce({
      state: "ready",
      reason: "lock",
      url: "http://127.0.0.1:3",
      stop: () => Promise.resolve({ state: "stopped", reasonCode: "stopped" }),
    });
    const exit = runTeacherHost(ARGV, ready.ports);
    await vi.waitFor(() => {
      expect(ready.stdout).toEqual(["Teacher host ready at http://127.0.0.1:3\n"]);
    });
    ready.signals.emit("SIGTERM");
    expect(await exit).toBe(0);
    expect(mocks.offer).toHaveBeenCalledTimes(2);
  });

  it("drains after start when a signal arrives while the host is starting", async () => {
    for (const signal of ["SIGINT", "SIGTERM"]) {
      const early = dependencies();
      const stop = vi.fn().mockResolvedValue({ state: "stopped", reasonCode: "stopped" });
      mocks.start.mockImplementationOnce(() => {
        early.signals.emit(signal);
        return Promise.resolve({ state: "ready", url: "http://127.0.0.1:4", stop });
      });
      expect(await runTeacherHost(ARGV, early.ports)).toBe(0);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(early.stdout).toEqual([
        "Teacher host ready at http://127.0.0.1:4\n",
        "Teacher host stopped.\n",
      ]);
      expect(["SIGINT", "SIGTERM"].map((name) => early.signals.listenerCount(name))).toEqual([
        0, 0,
      ]);
    }
  });

  it("serves until a signal, then reports a clean or uncertain stop", async () => {
    for (const [signal, stopped, code] of [
      ["SIGTERM", { state: "stopped", reasonCode: "stopped" }, 0],
      ["SIGINT", { state: "drain-expired", reasonCode: "drain-expired" }, 6],
    ] as const) {
      const running = dependencies();
      const stop = vi.fn().mockResolvedValue(stopped);
      mocks.start.mockImplementationOnce((options: { onEvaluationError: () => void }) => {
        options.onEvaluationError();
        return Promise.resolve({ state: "ready", url: "http://127.0.0.1:1", stop });
      });
      const exit = runTeacherHost(ARGV, running.ports);
      await vi.waitFor(() => {
        expect(running.stdout).toEqual(["Teacher host ready at http://127.0.0.1:1\n"]);
      });
      expect(stop).not.toHaveBeenCalled();
      running.signals.emit(signal);
      expect(await exit).toBe(code);
      expect(mocks.start).toHaveBeenLastCalledWith(
        expect.objectContaining({
          installationRoot: "/private/root",
          releaseId: "release:one",
          serve: mocks.serve,
          passwords: mocks.passwords,
        }),
      );
      expect(running.stderr[0]).toBe("Teacher host evaluation work failed; it will retry.\n");
      if (code === 0) expect(running.stdout.at(-1)).toBe("Teacher host stopped.\n");
      else expect(running.stderr.at(-1)).toBe("Teacher host stop is uncertain: drain-expired.\n");
    }
  });

  it("wires process ports and the root entry assigns the exit code", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const old = process.exitCode;
    try {
      mocks.start.mockResolvedValue({ state: "failed", reason: "lock" });
      expect(await runTeacherHostMain(ARGV)).toBe(3);
      expect(mocks.start).toHaveBeenCalledWith(
        expect.objectContaining({ serve: mocks.serve, passwords: mocks.passwords }),
      );
      expect(write).toHaveBeenCalledWith("Teacher host did not start: lock.\n");
      expect(mocks.offer).toHaveBeenCalledWith("/private/root", mocks.recovery);
      const argv = process.argv;
      process.argv = ["runtime", "executable", ...ARGV];
      try {
        await import("../../../teacher-host-entry.js");
        expect(process.exitCode).toBe(3);
      } finally {
        process.argv = argv;
      }
      mocks.start.mockResolvedValueOnce({
        state: "ready",
        url: "http://127.0.0.1:2",
        stop: () => Promise.resolve({ state: "stopped", reasonCode: "stopped" }),
      });
      const exit = runTeacherHostMain(ARGV);
      await vi.waitFor(() => {
        expect(out).toHaveBeenCalledWith("Teacher host ready at http://127.0.0.1:2\n");
      });
      process.emit("SIGTERM");
      expect(await exit).toBe(0);
    } finally {
      process.exitCode = old;
      write.mockRestore();
      out.mockRestore();
    }
  });
});

it("writes structured inference diagnostics to the private stderr sink", async () => {
  const target = dependencies();
  const event = {
    runId: "run:test",
    requestId: "request:test",
    attempt: 1,
    startedAt: "start",
    endedAt: "end",
    durationMs: 60_000,
    limitMs: 60_000,
    code: "deadline-exceeded",
    emitted: true,
    settlement: "unknown" as const,
    retryable: false,
    retryBlockedBy: null,
  };
  mocks.start.mockImplementationOnce((options: TeacherHostOptions) => {
    options.onInferenceDiagnostic?.(event);
    return Promise.resolve({ state: "failed", reason: "listen" });
  });
  expect(await runTeacherHost(ARGV, target.ports)).toBe(5);
  expect(target.stderr).toEqual([
    JSON.stringify(event) + "\n",
    "Teacher host did not start: listen.\n",
  ]);
});
it("writes recognized private startup diagnostics to stderr as bounded JSON", async () => {
  const target = dependencies();
  const diagnostic = {
    kind: "dashboard-release",
    pluginId: "org.marea.theme.marea",
    reason: "required-missing",
    remedy: "rebuild-compatible-release",
  } as const;
  mocks.start.mockImplementationOnce((options: TeacherHostOptions) => {
    options.onStartupDiagnostic?.(diagnostic);
    return Promise.resolve({ state: "failed", reason: "config" });
  });
  expect(await runTeacherHost(ARGV, target.ports)).toBe(5);
  expect(target.stderr).toEqual([
    JSON.stringify(diagnostic) + "\n",
    "Teacher host did not start: config.\n",
  ]);
});
it("cancels private telemetry resolution when signalled during startup", async () => {
  const f = dependencies();
  const pending = Promise.withResolvers<{ state: "failed"; reason: "config" }>();
  mocks.start.mockReturnValueOnce(pending.promise);
  const running = runTeacherHost(ARGV, f.ports);
  const options = mocks.start.mock.calls[0]?.[0] as TeacherHostOptions;
  expect(options.startupSignal?.aborted).toBe(false);
  f.signals.emit("SIGTERM");
  expect(options.startupSignal?.aborted).toBe(true);
  pending.resolve({ state: "failed", reason: "config" });
  expect(await running).toBe(5);
});
