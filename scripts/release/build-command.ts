import { powershellLiteral } from "./preview-launchers.js";

/** Bun 1.4 on Windows misresolves workspace paths when spawned directly across drives. */
export function buildCommand(
  args: readonly [string, ...string[]],
  platform: NodeJS.Platform = process.platform,
): [string, string[]] {
  if (platform !== "win32" || args[0] !== "bun") return [args[0], args.slice(1)];
  return [
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `& ${args.map(powershellLiteral).join(" ")}; exit $LASTEXITCODE`,
    ],
  ];
}
