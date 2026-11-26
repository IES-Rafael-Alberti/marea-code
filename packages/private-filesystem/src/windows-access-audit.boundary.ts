import { execFile, type ExecException } from "node:child_process";
import { WINDOWS_ACCESS_AUDIT_SCRIPT } from "./windows-access-audit-script.js";
import { windowsPowerShell } from "./windows-powershell.js";

/** Broad principals the audit names by category, never by account name or SID. */
export type WindowsBroadPrincipal = "authenticated-users" | "everyone" | "other" | "users";

export type WindowsAccessAudit =
  | { readonly status: "private" }
  | { readonly status: "exposed"; readonly principals: readonly WindowsBroadPrincipal[] }
  /** `code` is `0x` plus the eight-digit Windows HRESULT, or a categorical reason. */
  | { readonly status: "failed"; readonly code: string };

const EXPOSED_OUTPUT =
  /^exposed:((?:authenticated-users|everyone|other|users)(?:,(?:authenticated-users|everyone|other|users))*)$/u;
const ERROR_OUTPUT = /^error:([0-9A-F]{8})$/u;

function failed(code: string): WindowsAccessAudit {
  return Object.freeze({ status: "failed", code });
}

function auditResult(error: ExecException | null, stdout: string): WindowsAccessAudit {
  const hresult = ERROR_OUTPUT.exec(stdout)?.[1];
  if (hresult !== undefined) return failed(`0x${hresult}`);
  if (error !== null) {
    if (error.killed === true) return failed("timeout");
    return failed(typeof error.code === "string" ? "spawn-failed" : "non-zero-exit");
  }
  if (stdout === "private") return Object.freeze({ status: "private" });
  const exposed = EXPOSED_OUTPUT.exec(stdout)?.[1];
  if (exposed === undefined) return failed("unexpected-output");
  const principals = exposed.split(",") as WindowsBroadPrincipal[];
  return Object.freeze({ status: "exposed", principals: Object.freeze(principals) });
}

/**
 * Read-only check of who may read a Windows directory. It never writes an ACL, never rejects
 * and resolves to a failure code instead of throwing, so callers can only warn.
 */
export function auditWindowsPrivateAccess(path: string): Promise<WindowsAccessAudit> {
  const powershell = windowsPowerShell(WINDOWS_ACCESS_AUDIT_SCRIPT);
  return new Promise((resolve) => {
    try {
      const child = execFile(
        powershell.file,
        powershell.args,
        { encoding: "utf8", timeout: 30_000, maxBuffer: 1024, windowsHide: true },
        (error, stdout) => {
          resolve(auditResult(error, stdout));
        },
      );
      // A child that exits before reading stdin must not raise an unhandled EPIPE.
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(Buffer.from(path).toString("base64"));
    } catch {
      resolve(failed("spawn-failed"));
    }
  });
}
