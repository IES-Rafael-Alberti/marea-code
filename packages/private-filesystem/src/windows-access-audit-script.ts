/**
 * Read-only: it never calls Set-Acl or changes ownership. The path arrives as base64 UTF-8 on
 * stdin; the output is `private`, `exposed:<categories>` or `error:<HRESULT>`, never a path or name.
 */
export const WINDOWS_ACCESS_AUDIT_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
try {
  $path = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd()))
  $acl = [IO.Directory]::GetAccessControl($path)
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  # The user, SYSTEM, Administrators and CREATOR OWNER are the default profile grants.
  $trusted = @($sid, 'S-1-5-18', 'S-1-5-32-544', 'S-1-3-0')
  $broad = @{ 'S-1-1-0' = 'everyone'; 'S-1-5-32-545' = 'users'; 'S-1-5-11' = 'authenticated-users' }
  # ReadData/ListDirectory, GENERIC_ALL and GENERIC_READ.
  $read = 1 -bor 0x10000000 -bor [int32]::MinValue
  $found = @()
  foreach ($rule in $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { continue }
    if (([int]$rule.FileSystemRights -band $read) -eq 0) { continue }
    $value = $rule.IdentityReference.Value
    if ($value -in $trusted) { continue }
    if ($broad.ContainsKey($value)) { $found += $broad[$value] } else { $found += 'other' }
  }
  if ($found.Count -eq 0) { [Console]::Out.Write('private') }
  else { [Console]::Out.Write('exposed:' + ((@($found) | Sort-Object -Unique) -join ',')) }
} catch {
  # Only the numeric HRESULT leaves the script; exception text may hold paths or names.
  $exception = $_.Exception
  while ($null -ne $exception.InnerException) { $exception = $exception.InnerException }
  [Console]::Out.Write('error:' + ('{0:X8}' -f $exception.HResult))
  exit 1
}
`;
