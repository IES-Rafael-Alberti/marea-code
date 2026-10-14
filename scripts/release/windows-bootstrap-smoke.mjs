import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { gzipSync } from "node:zlib";
import { bootstrapScript } from "./preview-publish.ts";
import { sha256 } from "./manifest.ts";
import { powershellLiteral } from "./preview-launchers.ts";

// Run the complete generated bootstrap in both Windows shells. Only the HTTP
// transfer is substituted: native detection, gzip, hashes and execution are real.
assert.equal(process.platform, "win32");
const architecture = process.env.EXPECTED_ARCH;
assert.ok(["x64", "arm64"].includes(architecture));
assert.equal(process.arch, architecture, "Acceptance runtime must be native");
const root = mkdtempSync(join(tmpdir(), "marea-windows-bootstrap-"));
const version = "0.1.0-preview.1";
try {
  const entry = join(root, "installer.mjs");
  const binary = join(root, "installer.exe");
  writeFileSync(
    entry,
    `import {writeFileSync} from 'node:fs';
await Bun.sleep(600);
writeFileSync(process.env.MAREA_BOOTSTRAP_RECEIPT, JSON.stringify({architecture:process.arch,args:process.argv.slice(2)}));
process.exit(Number(process.env.MAREA_BOOTSTRAP_EXIT || 0));`,
  );
  const built = spawnSync(process.execPath, ["build", entry, "--compile", "--outfile", binary], {
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(built.status, 0, built.stderr);
  const assets = join(root, "assets");
  mkdirSync(assets);
  const payloads = [readFileSync(binary), Buffer.from("synthetic signature verifier")];
  const files = payloads.map((payload, index) => {
    const hash = sha256(payload);
    writeFileSync(join(assets, `sha256-${hash}.gz`), gzipSync(payload));
    return {
      path: index === 0 ? "marea-install.exe" : "cosign.exe",
      sha256: hash,
      executable: true,
    };
  });
  const manifests = ["student-win32-x64", "student-win32-arm64", "server-win32-x64"].map((key) => ({
    component: key.split("-")[0],
    target: key.slice(key.indexOf("-") + 1),
    files: key.endsWith(architecture)
      ? files
      : files.map((file) => ({ ...file, sha256: "0".repeat(64) })),
  }));
  const bootstrap = join(root, "install.ps1");
  writeFileSync(bootstrap, bootstrapScript("school/marea", version, manifests, true));
  const server = "http://192.0.2.10:18787";

  function run(
    shell,
    scenario,
    prefix = "",
    component = "student",
    exitCode = "0",
    address = server,
  ) {
    const work = join(root, `${shell}-${scenario}-José's 日本語`);
    mkdirSync(work);
    const receipt = join(work, "receipt.json");
    const downloads = join(work, "downloads.txt");
    const driver = join(work, "driver.ps1");
    writeFileSync(
      driver,
      `\ufeff$ErrorActionPreference='Stop'
# A PowerShell 7 parent exports its module path; isolate the child shell's own
# built-in modules, just as a fresh Windows PowerShell terminal would load them.
$env:PSModulePath=[IO.Path]::Combine($PSHOME, 'Modules')
${prefix}
function Invoke-WebRequest {
  param([switch]$UseBasicParsing, [string]$Uri, [string]$OutFile)
  $base='https://github.com/school/marea/releases/download/v${version}/'
  if (-not $Uri.StartsWith($base)) { throw 'Unexpected download URL' }
  [System.IO.File]::AppendAllText(${powershellLiteral(downloads)}, $OutFile+[Environment]::NewLine)
  Copy-Item -LiteralPath (Join-Path ${powershellLiteral(assets)} $Uri.Substring($base.Length)) -Destination $OutFile
}
# Invoke the same in-memory script-block form shown in the dashboard. Repeating
# also checks that loading the native probe twice in one shell remains safe.
foreach ($attempt in 1..2) {
  & ([scriptblock]::Create((Get-Content -LiteralPath ${powershellLiteral(bootstrap)} -Raw))) -Component ${component} -Server ${powershellLiteral(address)} -Version '${version}'
}
`,
    );
    const result = spawnSync(shell, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", driver], {
      encoding: "utf8",
      timeout: 120_000,
      env: {
        ...process.env,
        MAREA_BOOTSTRAP_RECEIPT: receipt,
        MAREA_BOOTSTRAP_EXIT: exitCode,
        TEMP: work,
        TMP: work,
      },
    });
    if (existsSync(downloads))
      for (const downloaded of readFileSync(downloads, "utf8").trim().split(/\r?\n/u))
        assert.equal(existsSync(dirname(downloaded)), false, "Bootstrap temporary files leaked");
    return { result, receipt, downloads };
  }

  function fakePlatform(nativeMachine, succeeds) {
    return `Add-Type -Namespace Marea -Name BootstrapPlatform -MemberDefinition @'
public static bool IsWow64Process2(System.IntPtr process, out ushort processMachine, out ushort nativeMachine) {
  processMachine = 0; nativeMachine = ${nativeMachine}; return ${succeeds};
}
'@`;
  }

  for (const shell of ["powershell.exe", "pwsh.exe"]) {
    for (const component of architecture === "x64" ? ["student", "server"] : ["student"]) {
      const accepted = run(shell, component, "", component);
      assert.equal(accepted.result.status, 0, accepted.result.stderr);
      const receipt = JSON.parse(readFileSync(accepted.receipt, "utf8"));
      assert.equal(receipt.architecture, architecture);
      assert.deepEqual(receipt.args.slice(0, 6), [
        "preview",
        "install",
        component,
        "--repository",
        "school/marea",
        "--cosign",
      ]);
      assert.equal(receipt.args[6].endsWith("cosign.exe"), true);
      assert.deepEqual(receipt.args.slice(7), ["--version", version, "--server", server]);
      assert.equal(readFileSync(accepted.downloads, "utf8").trim().split(/\r?\n/u).length, 4);
    }
    const literalAddress = `${server}/a b/"quoted"/end\\`;
    const quoted = run(shell, "literal-arguments", "", "student", "0", literalAddress);
    assert.equal(quoted.result.status, 0, quoted.result.stderr);
    assert.equal(JSON.parse(readFileSync(quoted.receipt, "utf8")).args.at(-1), literalAddress);
    for (const [scenario, prefix] of [
      ["unsupported", fakePlatform(332, true)],
      ["native-query-failed", fakePlatform(0, false)],
    ]) {
      const denied = run(shell, scenario, prefix);
      assert.notEqual(denied.result.status, 0);
      assert.equal(existsSync(denied.downloads), false, "Unsupported hosts must not download");
      assert.equal(existsSync(denied.receipt), false);
    }
    const failed = run(shell, "installer-failed", "", "student", "7");
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /Marea installation failed/u);
    const archive = join(assets, `sha256-${files[0].sha256}.gz`);
    const original = readFileSync(archive);
    writeFileSync(archive, gzipSync(Buffer.from("damaged installer")));
    const tampered = run(shell, "tampered");
    assert.notEqual(tampered.result.status, 0);
    assert.match(tampered.result.stderr, /Bootstrap checksum mismatch/u);
    assert.equal(existsSync(tampered.receipt), false, "Unverified code must never run");
    writeFileSync(archive, original);
    process.stdout.write(
      `${shell}: native ${architecture} bootstrap, checksum rejection and cleanup passed.\n`,
    );
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}
