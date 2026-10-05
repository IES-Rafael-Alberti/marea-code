import { cpSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { manifestSchema, sha256, type ReleaseManifest } from "./manifest.js";
import { ordinaryFiles, verifyFiles } from "./files.boundary.js";
import { manifestAsset, previewVersion, releaseUrl, repositoryName } from "./preview-channel.js";
import { powershellLiteral, shellLiteral } from "./preview-launchers.js";

const nativeMatrix = [
  "student-darwin-arm64",
  "server-darwin-arm64",
  "student-linux-x64",
  "server-linux-x64",
  "student-linux-arm64",
  "student-win32-x64",
  "server-win32-x64",
  "student-win32-arm64",
];

/** The pinned native CI signature tool travels with the candidate and is covered by its signature. */
export function includeSignatureTool(root: string, binary: string, license: string): void {
  const manifestPath = join(root, "manifest.json");
  const manifest = manifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const path = manifest.target.startsWith("win32-") ? "cosign.exe" : "cosign";
  cpSync(binary, join(root, path), { errorOnExist: true, force: false });
  mkdirSync(join(root, "licenses"), { recursive: true });
  cpSync(license, join(root, "licenses", "cosign-LICENSE"));
  const executables = new Set([
    ...manifest.files.filter((file) => file.executable).map((file) => file.path),
    path,
  ]);
  manifest.files = ordinaryFiles(root)
    .filter((file) => !["manifest.json", "manifest.sigstore.json"].includes(file))
    .map((file) => ({
      path: file,
      executable: executables.has(file),
      sha256: sha256(readFileSync(join(root, file))),
    }));
  writeFileSync(manifestPath, JSON.stringify(manifestSchema.parse(manifest), null, 2));
}

function bootstrapCases(manifests: readonly ReleaseManifest[], windows: boolean): string {
  const exe = windows ? ".exe" : "";
  return manifests
    .filter((manifest) => manifest.target.startsWith("win32-") === windows)
    .map((manifest) => {
      const installer = manifest.files.find((file) => file.path === `marea-install${exe}`);
      const cosign = manifest.files.find((file) => file.path === `cosign${exe}`);
      if (installer === undefined || cosign === undefined)
        throw new Error("Bootstrap programs missing");
      const key = `${manifest.component}-${manifest.target}`;
      return windows
        ? `  '${key}' { $installerHash='${installer.sha256}'; $cosignHash='${cosign.sha256}' }`
        : `  ${key}) installerHash='${installer.sha256}'; cosignHash='${cosign.sha256}' ;;`;
    })
    .join("\n");
}

export function bootstrapScript(
  repository: string,
  version: string,
  manifests: readonly ReleaseManifest[],
  windows: boolean,
): string {
  const base = releaseUrl(repository, version, "sha256-placeholder").replace(
    "sha256-placeholder",
    "",
  );
  if (windows)
    return `param([ValidateSet('student','server')][string]$Component='student', [string]$Server='')
$ErrorActionPreference='Stop'
$architecture=[System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
switch ("$Component-win32-$architecture") {
${bootstrapCases(manifests, true)}
  default { throw 'Unsupported native platform' }
}
$temp=Join-Path ([System.IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
New-Item -ItemType Directory -Path $temp | Out-Null
try {
  foreach ($entry in @(@('marea-install.exe',$installerHash),@('cosign.exe',$cosignHash))) {
    $path=Join-Path $temp $entry[0]
    Invoke-WebRequest -Uri (${powershellLiteral(base)}+'sha256-'+$entry[1]) -OutFile $path
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash.ToLowerInvariant() -cne $entry[1]) { throw 'Bootstrap checksum mismatch' }
  }
  $arguments=@('preview','install',$Component,'--repository',${powershellLiteral(repository)},'--version',${powershellLiteral(version)},'--cosign',(Join-Path $temp 'cosign.exe'))
  if ($Server) { $arguments+=@('--server',$Server) }
  & (Join-Path $temp 'marea-install.exe') @arguments
  if ($LASTEXITCODE -ne 0) { throw 'Marea installation failed' }
} finally { Remove-Item -LiteralPath $temp -Recurse -Force }
`;
  return `#!/bin/sh
set -eu
umask 077
component=\${1:-student}
if [ "$#" -gt 0 ]; then shift; fi
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) echo 'Unsupported OS' >&2; exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) echo 'Unsupported architecture' >&2; exit 1 ;; esac
case "$component-$os-$arch" in
${bootstrapCases(manifests, false)}
  *) echo 'Unsupported native platform' >&2; exit 1 ;;
esac
temp=$(mktemp -d)
trap 'rm -rf "$temp"' EXIT HUP INT TERM
download() {
  curl --fail --location --proto '=https' --tlsv1.2 --retry 2 ${shellLiteral(base)}"sha256-$2" -o "$temp/$1"
  if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$temp/$1" | cut -d ' ' -f 1); else actual=$(shasum -a 256 "$temp/$1" | cut -d ' ' -f 1); fi
  [ "$actual" = "$2" ] || { echo 'Bootstrap checksum mismatch' >&2; exit 1; }
  chmod 700 "$temp/$1"
}
download marea-install "$installerHash"
download cosign "$cosignHash"
"$temp/marea-install" preview install "$component" --repository ${shellLiteral(repository)} --version ${shellLiteral(version)} --cosign "$temp/cosign" "$@" < /dev/tty
`;
}

/** Produces an immutable set of GitHub assets only when every supported native candidate is present. */
export function preparePreviewPublication(
  candidates: readonly string[],
  output: string,
  repository: string,
  version: string,
): void {
  repositoryName.parse(repository);
  previewVersion.parse(version);
  const manifests = candidates.map((root) =>
    manifestSchema.parse(JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"))),
  );
  const keys = manifests.map((manifest) => `${manifest.component}-${manifest.target}`).sort();
  if (
    JSON.stringify(keys) !== JSON.stringify([...nativeMatrix].sort()) ||
    manifests.some((manifest) => manifest.version !== version)
  )
    throw new Error("A complete matching native preview matrix is required");
  mkdirSync(output);
  const copied = new Set<string>();
  for (const [index, manifest] of manifests.entries()) {
    const root = String(candidates[index]);
    verifyFiles(root, manifest);
    const asset = manifestAsset(manifest.component, manifest.target);
    cpSync(join(root, "manifest.json"), join(output, asset));
    cpSync(join(root, "manifest.sigstore.json"), join(output, `${asset}.sigstore.json`));
    for (const file of manifest.files) {
      if (copied.has(file.sha256)) continue;
      cpSync(join(root, file.path), join(output, `sha256-${file.sha256}`));
      copied.add(file.sha256);
    }
  }
  writeFileSync(join(output, "install.sh"), bootstrapScript(repository, version, manifests, false));
  writeFileSync(join(output, "install.ps1"), bootstrapScript(repository, version, manifests, true));
}

export function findCandidates(root: string): string[] {
  const entries = readdirSync(root, { withFileTypes: true });
  if (entries.some((entry) => entry.isFile() && entry.name === "manifest.json")) return [root];
  return entries
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => findCandidates(join(root, entry.name)));
}
