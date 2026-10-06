import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import {
  posixLauncher,
  powershellLiteral,
  shellLiteral,
  windowsLauncher,
} from "./preview-launchers.js";

it("executes the selected immutable program with literal paths and forwarded arguments", () => {
  const scratch = mkdtempSync(join(tmpdir(), "marea-launcher-"));
  const root = join(scratch, "student's $literal");
  const release = join(root, "programs/student-0.1.0-preview.1");
  try {
    mkdirSync(release, { recursive: true });
    writeFileSync(
      join(root, "programs/active.json"),
      JSON.stringify({ current: "student-0.1.0-preview.1", previous: null }),
    );
    writeFileSync(join(release, "marea-install"), "#!/bin/sh\nprintf '%s\\n' \"$@\"\n", {
      mode: 0o700,
    });
    const launcher = join(scratch, "marea");
    writeFileSync(launcher, posixLauncher(root, "student"));
    const result = spawnSync("sh", [launcher, "--lang", "eu", "space and $literal"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(
      `preview\nrun\nstudent\n--root\n${root}\n--\n--lang\neu\nspace and $literal\n`,
    );
    for (const current of [
      "server-0.1.0-preview.1",
      "student-../../outside",
      "student-x;echo bad",
    ]) {
      writeFileSync(
        join(root, "programs/active.json"),
        JSON.stringify({ current, previous: null }),
      );
      expect(spawnSync("sh", [launcher]).status).toBe(1);
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
});

it("quotes PowerShell literals and emits a strict component activation check", () => {
  expect(powershellLiteral("C:\\User's $home")).toBe("'C:\\User''s $home'");
  expect(shellLiteral("safe")).toBe("'safe'");
  expect(windowsLauncher("C:\\User's $home", "server")).toContain("$root = 'C:\\User''s $home'");
  expect(windowsLauncher("C:\\User's $home", "server")).toContain("'^server-[a-zA-Z0-9.-]+$'");
  expect(windowsLauncher("C:\\User's $home", "server")).toContain("--root $root -- @args");
});

it("recognizes the exact previous Windows launcher without adding portable-uninstall commands", () => {
  expect(windowsLauncher("C:\\Marea", "student", false)).toMatchSnapshot("legacy Windows launcher");
});

it("marks new PowerShell scripts as UTF-8 so legacy Windows PowerShell preserves non-ASCII home paths", () => {
  const script = windowsLauncher("C:\\Users\\José 日本語", "student");
  expect(Buffer.from(script).subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
  expect(script).toContain("$root = 'C:\\Users\\José 日本語'");
  expect(
    windowsLauncher("C:\\Users\\José 日本語", "student", false).startsWith(
      "$ErrorActionPreference",
    ),
  ).toBe(true);
});
