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

export function windowsLauncher(root: string, selected: string): string {
  return `$ErrorActionPreference = 'Stop'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
$root = ${powershellLiteral(root)}
$active = (Get-Content -LiteralPath (Join-Path $root 'programs/active.json') -Raw | ConvertFrom-Json).current
if ($active -cnotmatch '^${selected}-[a-zA-Z0-9.-]+$') { throw 'Invalid activation' }
& (Join-Path $root "programs/$active/marea-install.exe") preview run ${selected} --root $root -- @args
exit $LASTEXITCODE
`;
}
