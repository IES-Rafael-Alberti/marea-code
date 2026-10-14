$ErrorActionPreference='Stop'
$username='marea'+[guid]::NewGuid().ToString('N').Substring(0,10)
$password=ConvertTo-SecureString ([guid]::NewGuid().ToString('N')+'Aa9!') -AsPlainText -Force
$account=New-LocalUser -Name $username -Password $password -AccountNeverExpires
$scratch=Join-Path $env:RUNNER_TEMP ('marea-user-'+[guid]::NewGuid().ToString('N'))
function Quote-Literal([string]$Value) { return "'"+$Value.Replace("'","''")+"'" }
try {
  Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $account
  New-Item -ItemType Directory -Path $scratch | Out-Null
  $workspace=(Get-Location).Path
  $bun=(Get-Command bun -CommandType Application).Source
  $principal='*'+$account.SID.Value
  foreach ($readable in @($workspace, (Split-Path $bun))) {
    # Bun's dependency cache can leave hard-linked files with protected ACLs.
    # Grant the disposable account read access to each fixture file explicitly.
    & icacls.exe $readable /grant "${principal}:(OI)(CI)RX" /T | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture read access' }
  }
  & icacls.exe $scratch /grant "${principal}:(OI)(CI)F" | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Could not grant fixture scratch access' }

  $driver=Join-Path $scratch 'run.ps1'
  @"
`$ErrorActionPreference='Stop'
`$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
`$principal=[Security.Principal.WindowsPrincipal]::new(`$identity)
if (`$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  throw 'Bootstrap acceptance must run without administrator privileges'
}
Write-Output 'Running bootstrap acceptance as a standard Windows user.'
`$env:EXPECTED_ARCH=$(Quote-Literal $env:EXPECTED_ARCH)
`$env:TEMP=$(Quote-Literal $scratch)
`$env:TMP=$(Quote-Literal $scratch)
& $(Quote-Literal $bun) scripts/release/windows-bootstrap-smoke.mjs
exit `$LASTEXITCODE
"@ | Set-Content -LiteralPath $driver -Encoding utf8
  $credential=[Management.Automation.PSCredential]::new("$env:COMPUTERNAME\$username",$password)
  $stdout=Join-Path $scratch 'stdout.log'
  $stderr=Join-Path $scratch 'stderr.log'
  $result=Start-Process powershell.exe -Credential $credential -LoadUserProfile -WorkingDirectory $workspace -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$driver`"" -NoNewWindow -Wait -PassThru -RedirectStandardOutput $stdout -RedirectStandardError $stderr
  Get-Content -LiteralPath $stdout
  Get-Content -LiteralPath $stderr
  if ($result.ExitCode -ne 0) { throw "Standard-user bootstrap failed (exit $($result.ExitCode))" }
} finally {
  Remove-LocalUser -Name $username
  Remove-Item -LiteralPath $scratch -Recurse -Force -ErrorAction SilentlyContinue
}
