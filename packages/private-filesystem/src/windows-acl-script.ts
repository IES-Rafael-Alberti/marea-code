/** Paths arrive as JSON on stdin, never as PowerShell source. No sensitive output. */
export const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A Bun child of PowerShell 7 can inherit module paths incompatible with Windows PowerShell.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
try {
  $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $path = [string]$request.path
  $path = [IO.Path]::GetFullPath($path)
  $volume = [IO.Path]::GetPathRoot($path)
  $drive = [IO.DriveInfo]::new($volume)
  if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) { throw 'unsafe' }
  $cursor = $volume
  $item = Get-Item -LiteralPath $cursor -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  $parts = $path.Substring($volume.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)
  foreach ($part in $parts) {
    $cursor = [IO.Path]::Combine($cursor, $part)
    $item = Get-Item -LiteralPath $cursor -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'unsafe' }
  }
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.action -eq 'secure') {
    $acl = if ($item.PSIsContainer) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($item.PSIsContainer) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $identity = [Security.Principal.SecurityIdentifier]::new($principal)
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    Set-Acl -LiteralPath $path -AclObject $acl
  }
  $acl = Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'unsafe' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'unsafe' }
  $userAccess = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'unsafe' }
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'unsafe' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
      if ($item.PSIsContainer -and $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'unsafe' }
      if ($item.PSIsContainer -and ($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit') -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit') { throw 'unsafe' }
      $userAccess = $true
    }
  }
  if (-not $userAccess) { throw 'unsafe' }
  if ($item.PSIsContainer) { [Console]::Out.Write('directory') } else { [Console]::Out.Write('file') }
} catch { [Console]::Out.Write('unsafe'); exit 1 }
`;
