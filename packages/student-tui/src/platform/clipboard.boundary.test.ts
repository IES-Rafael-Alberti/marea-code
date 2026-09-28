import { EventEmitter } from "node:events";
import { beforeEach, expect, it, vi } from "vitest";
const spawn = vi.hoisted(() =>
  vi.fn<
    (
      command: string,
      args: string[],
      options: { stdio: string[]; timeout: number },
    ) => ReturnType<typeof child>
  >(),
);
vi.mock("node:child_process", () => ({ spawn }));
import { copyNativeClipboard } from "./clipboard.boundary.js";

beforeEach(() => spawn.mockReset());
function child(result: number | "spawn-error" | "stdin-error") {
  const stream = Object.assign(new EventEmitter(), { end: vi.fn() });
  const process = Object.assign(new EventEmitter(), { stdin: stream });
  queueMicrotask(() => {
    if (result === "spawn-error") process.emit("error", new Error("missing"));
    else if (result === "stdin-error") stream.emit("error", new Error("closed"));
    else process.emit("close", result);
  });
  return process;
}
it.each(["darwin", "win32"] as const)(
  "passes arbitrary clipboard contents only through stdin on %s",
  async (platform) => {
    const process = child(0);
    spawn.mockReturnValue(process);
    const text = "$(touch /tmp/not-executed)\nñ\x1b]52;payload";
    await expect(copyNativeClipboard(text, platform)).resolves.toBe(true);
    expect(spawn).toHaveBeenCalledExactlyOnceWith(
      platform === "darwin" ? "/usr/bin/pbcopy" : "clip.exe",
      [],
      { stdio: ["pipe", "ignore", "ignore"], timeout: 2000 },
    );
    expect(process.stdin.end).toHaveBeenCalledExactlyOnceWith(text);
  },
);
it("tries Linux clipboard providers in order and accepts a successful fallback", async () => {
  spawn
    .mockImplementationOnce(() => child("spawn-error"))
    .mockImplementationOnce(() => child("stdin-error"))
    .mockImplementationOnce(() => child(0));
  await expect(copyNativeClipboard("text", "linux")).resolves.toBe(true);
  expect(spawn.mock.calls.map(([name, args]) => [name, args])).toEqual([
    ["wl-copy", []],
    ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]],
  ]);
});
it("reports failure after unavailable or timed-out providers without throwing", async () => {
  spawn.mockImplementation(() => child(1));
  await expect(copyNativeClipboard("text", "linux")).resolves.toBe(false);
  expect(spawn).toHaveBeenCalledTimes(3);
});
it("uses the host platform when none is provided", async () => {
  spawn.mockImplementation(() => child(0));
  await expect(copyNativeClipboard("text")).resolves.toBe(true);
  expect(spawn.mock.calls[0]?.[0]).toBe(
    process.platform === "darwin"
      ? "/usr/bin/pbcopy"
      : process.platform === "win32"
        ? "clip.exe"
        : "wl-copy",
  );
});
