import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { auditWindowsPrivateAccess } from "./windows-access-audit.boundary.js";
import { WINDOWS_ACCESS_AUDIT_SCRIPT } from "./windows-access-audit-script.js";
import { WINDOWS_ACL_SCRIPT } from "./windows-acl-script.js";

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));
const execFile = vi.mocked(childProcess.execFile);
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

type Callback = (error: childProcess.ExecException | null, stdout: string) => void;

interface FakeStdin extends EventEmitter {
  end: ReturnType<typeof vi.fn>;
}

function answer(error: childProcess.ExecException | null, stdout: string): FakeStdin {
  const stdin = Object.assign(new EventEmitter(), { end: vi.fn() });
  execFile.mockImplementation(((
    _file: string,
    _args: string[],
    _options: object,
    callback: Callback,
  ) => {
    queueMicrotask(() => {
      callback(error, stdout);
    });
    return { stdin };
  }) as never);
  return stdin;
}

function exitError(fields: Partial<childProcess.ExecException>) {
  return Object.assign(new Error("synthetic"), fields) as childProcess.ExecException;
}

describe("auditWindowsPrivateAccess", () => {
  it("runs a fixed read-only script and passes the path only as base64 stdin", async () => {
    vi.stubEnv("SystemRoot", "D:\\Windows");
    const stdin = answer(null, "private");
    const path = "C:\\Users\\José\\.marea\\$(unsafe);'\"state";
    await expect(auditWindowsPrivateAccess(path)).resolves.toEqual({ status: "private" });
    expect(execFile).toHaveBeenCalledWith(
      "D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(WINDOWS_ACCESS_AUDIT_SCRIPT, "utf16le").toString("base64"),
      ],
      { encoding: "utf8", timeout: 30_000, maxBuffer: 1024, windowsHide: true },
      expect.any(Function),
    );
    expect(stdin.end).toHaveBeenCalledWith(Buffer.from(path).toString("base64"));
    expect(() => stdin.emit("error", new Error("EPIPE"))).not.toThrow();
  });

  it("never writes an ACL or changes ownership, unlike the shared secure script", () => {
    for (const write of [
      "Set-Acl",
      "SetOwner",
      "SetAccessRule",
      "AddAccessRule",
      "SetAccessControl",
    ]) {
      expect(WINDOWS_ACCESS_AUDIT_SCRIPT).not.toContain(write);
    }
    // The teacher server's default stays strict: its script still protects the folder.
    expect(WINDOWS_ACL_SCRIPT).toContain("Set-Acl -LiteralPath $path -AclObject $acl");
    expect(WINDOWS_ACL_SCRIPT).toContain("$acl.SetAccessRuleProtection($true, $false)");
  });

  it("reads the folder ACL and prints only categories or the HRESULT", () => {
    for (const fragment of [
      "$acl = [IO.Directory]::GetAccessControl($path)",
      "[Console]::Out.Write('private')",
      "[Console]::Out.Write('exposed:' + ((@($found) | Sort-Object -Unique) -join ','))",
      "[Console]::Out.Write('error:' + ('{0:X8}' -f $exception.HResult))",
      "'S-1-1-0' = 'everyone'; 'S-1-5-32-545' = 'users'; 'S-1-5-11' = 'authenticated-users'",
    ]) {
      expect(WINDOWS_ACCESS_AUDIT_SCRIPT).toContain(fragment);
    }
  });

  it("reports broad readers by category only", async () => {
    answer(null, "exposed:authenticated-users,everyone,other,users");
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({
      status: "exposed",
      principals: ["authenticated-users", "everyone", "other", "users"],
    });
    answer(null, "exposed:users");
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({
      status: "exposed",
      principals: ["users"],
    });
  });

  it("keeps the numeric HRESULT of a failed check", async () => {
    answer(exitError({ code: 1 }), "error:80070005");
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({
      status: "failed",
      code: "0x80070005",
    });
  });

  it.each([
    ["timeout", exitError({ killed: true, code: 1 }), ""],
    ["spawn-failed", exitError({ code: "ENOENT" }), ""],
    ["non-zero-exit", exitError({ code: 1 }), "error:C:\\Users\\name"],
    ["non-zero-exit", exitError({ killed: false, code: 1 }), ""],
    ["unexpected-output", null, ""],
    ["unexpected-output", null, "exposed:"],
    ["unexpected-output", null, "exposed:S-1-5-21-1"],
    ["unexpected-output", null, "exposed:users,"],
    ["unexpected-output", null, " private"],
    ["unexpected-output", null, "private\n"],
    ["unexpected-output", null, "error:8007000"],
    ["unexpected-output", null, "error:800700055"],
    ["unexpected-output", null, "xerror:80070005"],
    ["unexpected-output", null, "xexposed:users"],
    ["unexpected-output", null, "exposed:usersx"],
  ])("reports %s without echoing the output", async (code, error, stdout) => {
    answer(error, stdout);
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({
      status: "failed",
      code,
    });
  });

  it("resolves instead of throwing when PowerShell cannot be started", async () => {
    execFile.mockImplementation(() => {
      throw new Error("spawn EPERM");
    });
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({
      status: "failed",
      code: "spawn-failed",
    });
  });

  it("tolerates a child without a stdin pipe", async () => {
    execFile.mockImplementation(((
      _file: string,
      _args: string[],
      _options: object,
      callback: Callback,
    ) => {
      queueMicrotask(() => {
        callback(null, "private");
      });
      return { stdin: null };
    }) as never);
    await expect(auditWindowsPrivateAccess("C:\\state")).resolves.toEqual({ status: "private" });
  });
});
