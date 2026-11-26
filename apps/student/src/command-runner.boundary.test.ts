import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runProjectCommand } from "./command-runner.boundary.js";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("bounds output, preserves the exit code and rejects pre-aborted or unspawnable commands", async () => {
  const result = await runProjectCommand(
    tmpdir(),
    "printf '%20000s' x; exit 7",
    new AbortController().signal,
  );
  expect(JSON.parse(result)).toMatchObject({ exitCode: 7, truncated: true, stopped: false });
  const stderrResult = await runProjectCommand(
    tmpdir(),
    "printf error >&2",
    new AbortController().signal,
  );
  expect(JSON.parse(stderrResult)).toEqual({
    exitCode: 0,
    stopped: false,
    truncated: false,
    output: "error",
  });
  expect(() => runProjectCommand(tmpdir(), "true", AbortSignal.abort())).toThrow();
  await expect(
    runProjectCommand("/nonexistent-marea-cwd", "true", new AbortController().signal),
  ).rejects.toThrow();
});
it("cancels a command and falls back to the child handle if process group signalling fails", async () => {
  const signal = new AbortController();
  const running = runProjectCommand(tmpdir(), "sleep 30", signal.signal);
  const kill = vi.spyOn(process, "kill").mockImplementationOnce(() => {
    throw Object.assign(new Error("group denied"), { code: "EPERM" });
  });
  signal.abort();
  expect(JSON.parse(await running)).toMatchObject({ stopped: true });
  expect(kill).toHaveBeenCalledWith(expect.any(Number), "SIGTERM");
});
it("enforces the deadline and escalates when a shell ignores termination", async () => {
  const root = await mkdtemp(join(tmpdir(), "marea-command-deadline-"));
  try {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const started = Date.now();
    const running = runProjectCommand(
      root,
      "trap '' TERM; touch ready; while :; do :; done",
      new AbortController().signal,
    );
    await vi.waitFor(() => access(join(root, "ready")));
    const kill = vi.spyOn(process, "kill");
    // Readiness polling can already have advanced the fake clock.
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersToNextTimerAsync();
    expect(Date.now() - started).toBe(600_000);
    let settled = false;
    void running.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(999);
    expect(kill).toHaveBeenCalledExactlyOnceWith(expect.any(Number), "SIGTERM");
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(JSON.parse(await running)).toMatchObject({
      stopped: true,
      truncated: false,
      exitCode: null,
    });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it("catches cancellation that races with installing the listener", async () => {
  const signal = new AbortController().signal;
  vi.spyOn(signal, "aborted", "get").mockReturnValue(true);
  expect(JSON.parse(await runProjectCommand(tmpdir(), "sleep 30", signal))).toMatchObject({
    stopped: true,
  });
});

it.runIf(process.platform === "win32")(
  "keeps inner quotes and UTF-8 output on the real Windows command processor",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "marea ñ "));
    try {
      const result = await runProjectCommand(
        directory,
        'echo "two words" & echo canción & cd',
        new AbortController().signal,
      );
      const parsed = JSON.parse(result) as { exitCode: number; output: string };
      expect(parsed.exitCode).toBe(0);
      expect(parsed.output).toContain('"two words"');
      expect(parsed.output).toContain("canción");
      expect(parsed.output).toContain("marea ñ ");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
