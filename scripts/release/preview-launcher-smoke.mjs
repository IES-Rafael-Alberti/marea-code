import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { securePrivatePath } from "@marea/private-filesystem";
import { posixLauncher, windowsLauncher } from "./preview-launchers.ts";

const source = realpathSync(resolve(process.argv[2]));
const manifest = JSON.parse(readFileSync(join(source, "manifest.json"), "utf8"));
const scratch = realpathSync(mkdtempSync(join(tmpdir(), "marea-managed-launcher-")));
try {
  const root = join(scratch, "José's $literal home 日本語");
  const current = `${manifest.component}-${manifest.version}`;
  const release = join(root, "programs", current);
  mkdirSync(release, { recursive: true, mode: 0o700 });
  const windows = process.platform === "win32";
  const binary = windows ? "marea-install.exe" : "marea-install";
  cpSync(join(source, binary), join(release, binary));
  writeFileSync(join(root, "programs/active.json"), JSON.stringify({ current, previous: null }));
  securePrivatePath(root, 0o700);
  const launcher = join(scratch, windows ? "launch.ps1" : "launch.sh");
  writeFileSync(
    launcher,
    windows ? windowsLauncher(root, manifest.component) : posixLauncher(root, manifest.component),
  );
  const command = windows ? "powershell.exe" : "sh";
  const args = windows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "--help"]
    : [launcher, "--help"];
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, `Managed launcher failed: ${result.stderr}`);
  assert.match(result.stdout, /Marea preview:/u);
  // A component mismatch must fail before invoking another executable.
  writeFileSync(
    join(root, "programs/active.json"),
    JSON.stringify({ current: "other-1", previous: null }),
  );
  assert.notEqual(spawnSync(command, args, { encoding: "utf8", timeout: 30_000 }).status, 0);
  // Exercise the distributed installer, including Windows executable self-removal through its temporary launcher copy.
  writeFileSync(join(root, "programs/active.json"), JSON.stringify({ current, previous: null }));
  writeFileSync(
    join(root, "preview.json"),
    JSON.stringify({
      format: 1,
      repository: "school/marea",
      component: "student",
      channel: "preview",
    }),
  );
  mkdirSync(join(root, "student-state"));
  writeFileSync(join(root, "student-state", "credential"), "private test credential");
  const project = join(scratch, "project.txt");
  writeFileSync(project, "preserve student work");
  // Uninstall is independent of the component of the fixture installer binary.
  const studentCurrent = `student-${manifest.version}`;
  const studentRelease = join(root, "programs", studentCurrent);
  if (current !== studentCurrent) cpSync(release, studentRelease, { recursive: true });
  writeFileSync(
    join(root, "programs/active.json"),
    JSON.stringify({ current: studentCurrent, previous: null }),
  );
  writeFileSync(
    launcher,
    windows ? windowsLauncher(root, "student") : posixLauncher(root, "student"),
  );
  const uninstallArgs = windows
    ? ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", launcher, "uninstall", "--yes"]
    : [launcher, "uninstall", "--yes"];
  const removed = spawnSync(command, uninstallArgs, {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, HOME: scratch, USERPROFILE: scratch },
  });
  assert.equal(removed.status, 0, `Managed uninstall failed: ${removed.stderr}`);
  assert.equal(existsSync(root), false, "Managed installation must be removed completely");
  assert.equal(readFileSync(project, "utf8"), "preserve student work");
  process.stdout.write(
    "Native managed launcher passed, including literal paths, rejected activation and clean managed uninstall.\n",
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
