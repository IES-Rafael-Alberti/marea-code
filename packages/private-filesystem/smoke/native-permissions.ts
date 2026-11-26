import { openSqliteDatabaseFile } from "@marea/sqlite-storage";
import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditWindowsPrivateAccess, inspectPrivatePath, securePrivatePath } from "../src/index.js";
import { WINDOWS_ACL_SCRIPT } from "../src/windows-acl-script.js";

const root = mkdtempSync(join(tmpdir(), "marea-native-privacy-"));
const checks: string[] = [];
let diagnosticPath = root;
let failed = false;
function cleanup(): void {
  securePrivatePath(root, 0o700);
  rmSync(root, { recursive: true, force: true });
}
function powershell(source: string, path: string): void {
  const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; $env:PSModulePath=[IO.Path]::Combine($PSHOME,'Modules'); $path=[Console]::In.ReadToEnd(); ${source}`;
  const result = spawnSync(
    join(
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
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { input: path, encoding: "utf8", timeout: 30_000, maxBuffer: 4096, windowsHide: true },
  );
  assert.equal(result.status, 0, "Native ACL fixture creation failed");
}
function rejectRule(name: string, sid: string, access: string, propagation: string): void {
  securePrivatePath(root, 0o700);
  const rights = access === "Deny" ? "Delete" : "FullControl";
  powershell(
    `$acl=Get-Acl -LiteralPath $path; $sid=${sid}; $rule=[Security.AccessControl.FileSystemAccessRule]::new($sid,[Security.AccessControl.FileSystemRights]::${rights},[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::${propagation},[Security.AccessControl.AccessControlType]::${access}); $acl.SetAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl`,
    root,
  );
  assert.equal(inspectPrivatePath(root), undefined, name);
  checks.push(name);
}
try {
  securePrivatePath(root, 0o700);
  assert.equal(inspectPrivatePath(root), "directory");
  const child = join(root, "child");
  mkdirSync(child, { mode: 0o700 });
  diagnosticPath = child;
  assert.equal(inspectPrivatePath(child), "directory");
  for (const name of ["database.sqlite", "database.sqlite-wal", "database.sqlite-shm", "lock"]) {
    const path = join(child, name);
    writeFileSync(path, "synthetic", { mode: 0o600 });
    assert.equal(inspectPrivatePath(path), "file");
  }
  checks.push("private-created-child-files");
  const unicode = join(root, "José 日本語");
  mkdirSync(unicode, { mode: 0o700 });
  diagnosticPath = unicode;
  securePrivatePath(unicode, 0o700);
  assert.equal(inspectPrivatePath(unicode), "directory");
  const unicodeFile = join(unicode, "sesión.json");
  writeFileSync(unicodeFile, "synthetic", { mode: 0o600 });
  securePrivatePath(unicodeFile, 0o600);
  assert.equal(inspectPrivatePath(unicodeFile), "file");
  checks.push("unicode-private-paths");
  const databasePath = join(child, "live.sqlite");
  writeFileSync(databasePath, "", { mode: 0o600 });
  const storage = openSqliteDatabaseFile({ databasePath });
  try {
    storage.database.execute("CREATE TABLE native_privacy (value TEXT NOT NULL)");
    storage.database.execute("INSERT INTO native_privacy VALUES ('synthetic')");
    for (const suffix of ["", "-wal", "-shm"]) {
      assert.equal(inspectPrivatePath(`${databasePath}${suffix}`), "file");
    }
    checks.push("real-sqlite-wal-and-shm-private");
  } finally {
    storage.close();
  }
  if (process.platform === "win32") {
    rejectRule(
      "broad-allow",
      "[Security.Principal.SecurityIdentifier]::new('S-1-1-0')",
      "Allow",
      "None",
    );
    assert.equal(inspectPrivatePath(child), undefined, "Inherited broad grant must fail");
    checks.push("inherited-broad-allow");
    rejectRule(
      "no-propagation",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User",
      "Allow",
      "NoPropagateInherit",
    );
    rejectRule(
      "explicit-deny",
      "[Security.Principal.WindowsIdentity]::GetCurrent().User",
      "Deny",
      "None",
    );
    securePrivatePath(root, 0o700);
    powershell(
      "$acl=Get-Acl -LiteralPath $path; $acl.SetSecurityDescriptorSddlForm('D:NO_ACCESS_CONTROL',[Security.AccessControl.AccessControlSections]::Access); Set-Acl -LiteralPath $path -AclObject $acl",
      root,
    );
    assert.equal(inspectPrivatePath(root), undefined, "Null DACL must fail");
    checks.push("null-dacl");
    securePrivatePath(root, 0o700);
    const link = join(root, "junction");
    powershell(
      "New-Item -ItemType Junction -Path (Join-Path $path 'junction') -Target (Join-Path $path 'child') | Out-Null",
      root,
    );
    assert.equal(inspectPrivatePath(link), undefined);
    assert.equal(inspectPrivatePath(join(link, "lock")), undefined);
    assert.throws(() => {
      securePrivatePath(link, 0o700);
    });
    assert.throws(() => {
      securePrivatePath(join(link, "lock"), 0o600);
    });
    assert.throws(() => {
      securePrivatePath(join(link, "absent"), 0o600);
    });
    assert.equal(inspectPrivatePath(join(link, "absent")), undefined);
    assert.equal(inspectPrivatePath(child), "directory");
    assert.equal(inspectPrivatePath(join(child, "lock")), "file");
    checks.push("junction-and-junction-ancestor");
    // The student only audits its folder: the check must never change the ACL it reads.
    securePrivatePath(root, 0o700);
    assert.deepEqual(await auditWindowsPrivateAccess(root), { status: "private" });
    assert.equal(inspectPrivatePath(root), "directory", "Audit must not change the ACL");
    for (const [sid, category] of [
      ["S-1-1-0", "everyone"],
      ["S-1-5-32-545", "users"],
    ] as const) {
      powershell(
        `$acl=Get-Acl -LiteralPath $path; $rule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new('${sid}'),[Security.AccessControl.FileSystemRights]::ReadAndExecute,[Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit',[Security.AccessControl.PropagationFlags]::None,[Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); Set-Acl -LiteralPath $path -AclObject $acl`,
        root,
      );
      assert.deepEqual(
        await auditWindowsPrivateAccess(root),
        {
          status: "exposed",
          principals: category === "users" ? ["everyone", "users"] : [category],
        },
        `Audit must report ${category}`,
      );
    }
    const missing = await auditWindowsPrivateAccess(join(root, "absent"));
    assert.equal(missing.status, "failed");
    assert.match(missing.code, /^0x[0-9A-F]{8}$/u);
    securePrivatePath(root, 0o700);
    checks.push("read-only-student-audit");
  }
  console.log(
    JSON.stringify({ platform: process.platform, arch: process.arch, checks, status: "passed" }),
  );
} catch (error) {
  failed = true;
  console.error("Completed native privacy checks:", checks);
  if (process.platform === "win32") {
    // Diagnostics are restricted to this synthetic, disposable fixture.
    const diagnostic = WINDOWS_ACL_SCRIPT.replace(
      "$rules = $acl.GetAccessRules",
      "[Console]::Error.WriteLine($acl.Sddl); [Console]::Error.WriteLine($sid.Value); $rules = $acl.GetAccessRules",
    ).replace(
      "$reason = $_.Exception.Message",
      "$reason = $_.Exception.Message; [Console]::Error.WriteLine($_.Exception.Message); [Console]::Error.WriteLine($_.ScriptStackTrace)",
    );
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(diagnostic, "utf16le").toString("base64"),
      ],
      {
        input: Buffer.from(JSON.stringify({ path: diagnosticPath, action: "inspect" })).toString(
          "base64",
        ),
        encoding: "utf8",
        timeout: 30000,
        maxBuffer: 65536,
      },
    );
    console.error("Synthetic ACL diagnostic:", {
      status: result.status,
      error: result.error?.message,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  }
  try {
    cleanup();
  } catch {
    // Preserve the original acceptance failure; the CI runner is disposable.
  }
  throw error;
} finally {
  if (!failed) cleanup();
}
