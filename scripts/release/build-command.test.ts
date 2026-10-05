import { expect, it } from "vitest";
import { buildCommand } from "./build-command.js";

it("keeps direct native execution outside Windows and for non-Bun tools", () => {
  expect(buildCommand(["bun", "install"], "linux")).toEqual(["bun", ["install"]]);
  expect(buildCommand(["git", "status"], "win32")).toEqual(["git", ["status"]]);
  expect(buildCommand(["git", "status"])).toEqual(["git", ["status"]]);
});

it("hosts Windows Bun in PowerShell, preserves literal arguments and propagates its exit status", () => {
  expect(
    buildCommand(["bun", "build", "C:\\User's $home\\entry.ts", "--compile"], "win32"),
  ).toEqual([
    "powershell.exe",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "& 'bun' 'build' 'C:\\User''s $home\\entry.ts' '--compile'; exit $LASTEXITCODE",
    ],
  ]);
});
