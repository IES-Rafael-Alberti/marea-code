import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PrivateFilesystemError } from "./private-filesystem-error.js";
import { checkWindowsPrivatePath, windowsPrivateKind } from "./windows-acl.boundary.js";
import { WINDOWS_ACL_SCRIPT } from "./windows-acl-script.js";

vi.mock("node:child_process", () => ({ spawnSync: vi.fn() }));
const spawn = vi.mocked(childProcess.spawnSync);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

type ResultOverrides = Partial<childProcess.SpawnSyncReturns<string>>;

function result(overrides: ResultOverrides = {}): childProcess.SpawnSyncReturns<string> {
  return {
    pid: 1,
    output: [],
    stdout: "",
    stderr: "",
    signal: null,
    status: 0,
    ...overrides,
  };
}

function mockOutput(stdout: string, status: number | null = 0): void {
  spawn.mockReturnValue(result({ stdout, status }));
}

function capturePrivateError(action: () => void): PrivateFilesystemError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(PrivateFilesystemError);
    return error as PrivateFilesystemError;
  }
  throw new Error("Expected PrivateFilesystemError to be thrown.");
}

describe("windowsPrivateKind", () => {
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

  it("fails closed on nonzero exit, null status and spawn errors", () => {
    mockOutput("file", 1);
    expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
    mockOutput("file", null);
    expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
    spawn.mockReturnValue(result({ stdout: "file", error: new Error("private process details") }));
    expect(windowsPrivateKind("C:/state", "inspect")).toBeUndefined();
  });

  it("rethrows an unexpected non-private error unchanged", () => {
    spawn.mockImplementation(() => {
      throw new Error("spawn threw");
    });
    expect(() => windowsPrivateKind("C:/state", "inspect")).toThrow("spawn threw");
  });
});

describe("checkWindowsPrivatePath", () => {
  it.each([
    "unsupported-volume",
    "reparse-point",
    "owner-mismatch",
    "foreign-ace",
    "missing-user-access",
    "unexpected",
  ])("maps the script reason %s to a typed diagnostic code", (reason) => {
    mockOutput(reason, 1);
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe(`private-fs.${reason}`);
    expect(spawn).toHaveBeenCalledTimes(1);
  });

  it("maps the transient script reason set-acl-failed after its single retry", () => {
    mockOutput("set-acl-failed", 1);
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.set-acl-failed");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it("reports spawn-failed for a non-timeout spawn error", () => {
    spawn.mockReturnValue(result({ stdout: "file", error: new Error("spawn blocked") }));
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.spawn-failed");
  });

  it("reports timeout for an ETIMEDOUT spawn error", () => {
    spawn.mockReturnValue(
      result({
        stdout: "file",
        status: null,
        error: Object.assign(new Error("timed out"), { code: "ETIMEDOUT" }),
      }),
    );
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.timeout");
  });

  it("reports timeout when the process is killed by a signal", () => {
    spawn.mockReturnValue(result({ stdout: "file", status: null, signal: "SIGTERM" }));
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.timeout");
  });

  it("reports non-zero-exit when the script exits without an allowlisted reason", () => {
    mockOutput("garbage", 1);
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.non-zero-exit");
  });

  it("reports unexpected-output for a zero exit with unrecognized output", () => {
    mockOutput("garbage", 0);
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.unexpected-output");
  });

  it.each(["\\\\server\\share\\state", "//server/share/state"])(
    "reports a UNC profile path %s as an unsupported volume without spawning",
    (path) => {
      const error = capturePrivateError(() => checkWindowsPrivatePath(path, "inspect"));
      expect(error.diagnosticCode).toBe("private-fs.unsupported-volume");
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("rejects a non-local path without spawning", () => {
    const error = capturePrivateError(() => checkWindowsPrivatePath("relative", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.unexpected");
    expect(spawn).not.toHaveBeenCalled();
  });

  it.each(["spawn-failed", "timeout", "set-acl-failed"])(
    "retries the transient reason %s once and recovers",
    (reason) => {
      if (reason === "spawn-failed") {
        spawn.mockReturnValueOnce(result({ stdout: "file", error: new Error("blocked") }));
      } else if (reason === "timeout") {
        spawn.mockReturnValueOnce(result({ stdout: "file", status: null, signal: "SIGTERM" }));
      } else {
        spawn.mockReturnValueOnce(result({ stdout: "set-acl-failed", status: 1 }));
      }
      spawn.mockReturnValueOnce(result({ stdout: "file", status: 0 }));
      expect(checkWindowsPrivatePath("C:/state", "inspect")).toBe("file");
      expect(spawn).toHaveBeenCalledTimes(2);
    },
  );

  it("reports the second transient failure when the retry also fails", () => {
    spawn.mockReturnValue(result({ stdout: "file", error: new Error("still blocked") }));
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe("private-fs.spawn-failed");
    expect(spawn).toHaveBeenCalledTimes(2);
  });

  it.each([
    "unsupported-volume",
    "reparse-point",
    "owner-mismatch",
    "foreign-ace",
    "missing-user-access",
    "unexpected",
    "non-zero-exit",
    "unexpected-output",
  ])("never retries the non-transient reason %s", (reason) => {
    if (reason === "non-zero-exit") {
      mockOutput("garbage", 1);
    } else if (reason === "unexpected-output") {
      mockOutput("garbage", 0);
    } else {
      mockOutput(reason, 1);
    }
    const error = capturePrivateError(() => checkWindowsPrivatePath("C:/state", "inspect"));
    expect(error.diagnosticCode).toBe(`private-fs.${reason}`);
    expect(spawn).toHaveBeenCalledTimes(1);
  });
});

describe("WINDOWS_ACL_SCRIPT", () => {
  it("reports allowlisted failure reasons without leaking exception text", () => {
    expect(WINDOWS_ACL_SCRIPT).toContain("unsupported-volume");
    expect(WINDOWS_ACL_SCRIPT).toContain("reparse-point");
    expect(WINDOWS_ACL_SCRIPT).toContain("owner-mismatch");
    expect(WINDOWS_ACL_SCRIPT).toContain("foreign-ace");
    expect(WINDOWS_ACL_SCRIPT).toContain("missing-user-access");
    expect(WINDOWS_ACL_SCRIPT).toContain("set-acl-failed");
    expect(WINDOWS_ACL_SCRIPT).toContain("'unexpected'");
    expect(WINDOWS_ACL_SCRIPT).toContain("GetAccessRules($true, $true");
    expect(WINDOWS_ACL_SCRIPT).toContain("$rules.Count -eq 0");
    expect(WINDOWS_ACL_SCRIPT).toContain("ReparsePoint");
    expect(WINDOWS_ACL_SCRIPT).toContain(
      "[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))",
    );
  });
});
