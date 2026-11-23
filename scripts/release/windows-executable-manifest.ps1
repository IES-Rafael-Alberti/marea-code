param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference='Stop'
$env:PSModulePath=[IO.Path]::Combine($PSHOME, 'Modules')

# Merge before hashing/signing. Preserve Bun's long-path and heap settings.
# The SDK tool can update ARM64 resources even when its own executable is x64.
$sdk=Join-Path ${env:ProgramFiles(x86)} 'Windows Kits/10/bin'
$tool=Get-ChildItem -LiteralPath $sdk -Directory |
  Sort-Object Name -Descending |
  ForEach-Object { Join-Path $_.FullName 'x64/mt.exe' } |
  Where-Object { Test-Path -LiteralPath $_ } |
  Select-Object -First 1
if (-not $tool) { throw 'Windows SDK manifest tool is required to build Marea' }

& $tool -nologo "-inputresource:$Executable;#1" -manifest (Join-Path $PSScriptRoot 'windows-application.manifest') "-outputresource:$Executable;#1"
if ($LASTEXITCODE -ne 0) { throw 'Could not embed the per-user execution manifest' }

$extracted=Join-Path ([IO.Path]::GetTempPath()) ([guid]::NewGuid().ToString()+'.manifest')
try {
  & $tool -nologo "-inputresource:$Executable;#1" "-out:$extracted"
  if ($LASTEXITCODE -ne 0) { throw 'Could not read back the embedded execution manifest' }
  [xml]$manifest=Get-Content -LiteralPath $extracted -Raw
  $levels=@($manifest.SelectNodes("//*[local-name()='requestedExecutionLevel']"))
  if ($levels.Count -ne 1 -or $levels[0].level -cne 'asInvoker' -or $levels[0].uiAccess -cne 'false') {
    throw 'Marea executables must run with the invoking user permissions'
  }
} finally {
  Remove-Item -LiteralPath $extracted -Force -ErrorAction SilentlyContinue
}
