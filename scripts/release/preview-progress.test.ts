import { afterEach, expect, it, vi } from "vitest";
import { installationProgress } from "./preview-progress.boundary.js";

const tty = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
afterEach(() => {
  vi.restoreAllMocks();
  if (tty) Object.defineProperty(process.stderr, "isTTY", tty);
  else Reflect.deleteProperty(process.stderr, "isTTY");
});

it("updates one terminal line at most once a second and separates every phase and final diagnostic", () => {
  Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
  const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
  const now = vi.spyOn(Date, "now").mockReturnValue(0);
  const progress = installationProgress();
  progress.stage("Downloading");
  progress.update("0 MiB");
  now.mockReturnValue(999);
  progress.update("hidden intermediate update");
  now.mockReturnValue(1000);
  progress.update("2 MiB");
  progress.stage("Installing");
  progress.update("new phase at the same time");
  progress.finish();
  progress.finish();
  expect(output.mock.calls).toEqual([
    ["Downloading\n"],
    ["\r\u001b[2K0 MiB"],
    ["\r\u001b[2K2 MiB"],
    ["\n"],
    ["Installing\n"],
    ["\r\u001b[2Knew phase at the same time"],
    ["\n"],
  ]);
});

it.each([false, undefined])(
  "keeps redirected progress readable without terminal escapes: %s",
  (isTTY) => {
    Object.defineProperty(process.stderr, "isTTY", { value: isTTY, configurable: true });
    const output = vi.spyOn(process.stderr, "write").mockReturnValue(true);
    const progress = installationProgress();
    progress.stage("Downloading");
    progress.update("1/2 files, 3.0 MiB");
    progress.finish();
    expect(output.mock.calls).toEqual([["Downloading\n"], ["1/2 files, 3.0 MiB\n"]]);
  },
);
