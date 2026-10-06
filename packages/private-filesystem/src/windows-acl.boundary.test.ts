import * as childProcess from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { windowsPrivateKind } from "./windows-acl.boundary.js";
import { WINDOWS_ACL_SCRIPT } from "./windows-acl-script.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(childProcess.spawnSync);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});
function result(stdout: string, status: number | null = 0): childProcess.SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout,
    stderr: "",
    signal: null,
    status,
  };
}
function mockOutput(stdout: string, status: number | null = 0): void {
  // Runtime uses encoding:utf8; preserve the real spawnSync overload's string output.
  spawn.mockReturnValue(result(stdout, status));
}
it.each([
  "relative",
  "relativeC:\\state",
  "1:\\state",
  "\\\\server\\share",
  "\\\\?\\C:\\root",
  "C:\\state:stream",
  "C:\\bad\0",
  "C:relative",
])("rejects non-local or alternate stream path %s before execution", (path) => {
  expect(windowsPrivateKind(path, "inspect")).toBeUndefined();
  expect(spawn).not.toHaveBeenCalled();
});
it("passes paths as ASCII-wrapped UTF-8 JSON stdin to a fixed noninteractive script", () => {
  vi.stubEnv("SystemRoot", "D:\\Windows");
  mockOutput("file");
  const path = "C:\\José 日本語\\$(unsafe);'\"state";
  expect(windowsPrivateKind(path, "inspect")).toBe("file");
  expect(spawn).toHaveBeenCalledWith(
    "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      input: Buffer.from(JSON.stringify({ path, action: "inspect" })).toString("base64"),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024,
      windowsHide: true,
    },
  );
  expect(WINDOWS_ACL_SCRIPT).toContain("GetAccessRules($true, $true");
  expect(WINDOWS_ACL_SCRIPT).toContain("$rules.Count -eq 0");
  expect(WINDOWS_ACL_SCRIPT).toContain("ReparsePoint");
  expect(WINDOWS_ACL_SCRIPT).toContain(
    "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
  );
});
it("uses the system fallback and accepts only exact successful directory/file outputs", () => {
  vi.stubEnv("SystemRoot", undefined);
  mockOutput("directory");
  expect(windowsPrivateKind("C:/state", "secure")).toBe("directory");
  expect(spawn.mock.calls[0]?.[0]).toBe(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  for (const output of ["", "unsafe", "file\n", "directory extra"]) {
    mockOutput(output);
    expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
  }
});
it("fails closed on nonzero exit, timeout and spawn errors", () => {
  mockOutput("file", 1);
  expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
  mockOutput("file", null);
  expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
  spawn.mockReturnValue({ ...result("file"), error: new Error("private process details") });
  expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
});
