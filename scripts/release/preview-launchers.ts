/** Quote literals without allowing command substitution, even for unusual home directory names. */
export const shellLiteral = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
export const powershellLiteral = (value: string): string => `'${value.replaceAll("'", "''")}'`;

export function posixLauncher(root: string, selected: string): string {
  return `#!/bin/sh
set -eu
root=${shellLiteral(root)}
active=$(sed -n 's/.*"current":"\\([^"]*\\)".*/\\1/p' "$root/programs/active.json")
case "$active" in ${selected}-*) ;; *) exit 1 ;; esac
case "$active" in *[!a-zA-Z0-9.-]*) exit 1 ;; esac
exec "$root/programs/$active/marea-install" preview run ${selected} --root "$root" -- "$@"
`;
}

export function windowsLauncher(root: string, selected: string, portableUninstall = true): string {
  // Windows PowerShell 5.1 requires a UTF-8 BOM for literal non-ASCII home paths.
  // Preserve the old bytes only when recognizing a legacy launcher for migration.
  return `${portableUninstall ? "\uFEFF" : ""}$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$root = ${powershellLiteral(root)}
$active = (Get-Content -LiteralPath (Join-Path $root 'programs/active.json') -Raw | ConvertFrom-Json).current
if ($active -cnotmatch '^${selected}-[a-zA-Z0-9.-]+$') { throw 'Invalid activation' }
${
  portableUninstall
    ? `if ($args.Count -gt 0 -and $args[0] -ceq 'uninstall') {
  $temp = Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString())
  New-Item -ItemType Directory -Path $temp | Out-Null
  try {
    $copy = Join-Path $temp 'marea-install.exe'
    Copy-Item -LiteralPath (Join-Path $root "programs/$active/marea-install.exe") -Destination $copy
    & $copy preview run ${selected} --root $root -- @args
    $code = $LASTEXITCODE
  } finally { Remove-Item -LiteralPath $temp -Recurse -Force }
  exit $code
}
`
    : ""
}& (Join-Path $root "programs/$active/marea-install.exe") preview run ${selected} --root $root -- @args
exit $LASTEXITCODE
`;
}
