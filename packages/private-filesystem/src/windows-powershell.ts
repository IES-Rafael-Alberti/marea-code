import { win32 } from "node:path";

/** Windows PowerShell 5.1 from System32 with a fixed, encoded, noninteractive script. */
export function windowsPowerShell(script: string): { file: string; args: string[] } {
  return {
    file: win32.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
    args: [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
  };
}
