import { spawnSync } from "node:child_process";
import { win32 } from "node:path";
import { WINDOWS_ACL_SCRIPT } from "./windows-acl-script.js";

export function windowsPrivateKind(
  path: string,
  action: "inspect" | "secure",
): "directory" | "file" | undefined {
  // Only local absolute DOS paths: no UNC, device aliases, ADS or NULs.
  if (!/^[a-zA-Z]:[\\/][^:\0]*$/.test(path)) return undefined;
  const result = spawnSync(
    win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(WINDOWS_ACL_SCRIPT, "utf16le").toString("base64"),
    ],
    {
      input: JSON.stringify({ path, action }),
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 1024,
      windowsHide: true,
    },
  );
  if (result.status !== 0 || result.error !== undefined) return undefined;
  return result.stdout === "file" || result.stdout === "directory" ? result.stdout : undefined;
}
