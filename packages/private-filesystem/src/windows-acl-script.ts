/** Paths arrive as base64-encoded UTF-8 JSON on stdin, never as PowerShell source. No sensitive output. */
export const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
# A Bun child of PowerShell 7 can inherit module paths incompatible with Windows PowerShell.
$env:PSModulePath = [IO.Path]::Combine($PSHOME, 'Modules')
try {
  # Console input codepages vary; an ASCII envelope preserves Unicode paths in redirected stdin.
  $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String([Console]::In.ReadToEnd())) | ConvertFrom-Json
  $path = [string]$request.path
  $path = [IO.Path]::GetFullPath($path)
  $volume = [IO.Path]::GetPathRoot($path)
  $drive = [IO.DriveInfo]::new($volume)
  if ($drive.DriveType -notin @([IO.DriveType]::Fixed, [IO.DriveType]::Removable, [IO.DriveType]::Ram)) { throw 'unsupported-volume' }
  $cursor = $volume
  $attributes = [IO.File]::GetAttributes($cursor)
  if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-point' }
  $parts = $path.Substring($volume.Length).Split([char[]]@([IO.Path]::DirectorySeparatorChar), [StringSplitOptions]::RemoveEmptyEntries)
  foreach ($part in $parts) {
    $cursor = [IO.Path]::Combine($cursor, $part)
    $attributes = [IO.File]::GetAttributes($cursor)
    if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse-point' }
  }
  $isDirectory = ($attributes -band [IO.FileAttributes]::Directory) -ne 0
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  if ($request.action -eq 'secure') {
    $acl = if ($isDirectory) { [Security.AccessControl.DirectorySecurity]::new() } else { [Security.AccessControl.FileSecurity]::new() }
    $acl.SetOwner($sid)
    $acl.SetAccessRuleProtection($true, $false)
    $inherit = if ($isDirectory) { [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit' } else { [Security.AccessControl.InheritanceFlags]::None }
    foreach ($principal in @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) {
      $identity = [Security.Principal.SecurityIdentifier]::new($principal)
      $rule = [Security.AccessControl.FileSystemAccessRule]::new($identity, [Security.AccessControl.FileSystemRights]::FullControl, $inherit, [Security.AccessControl.PropagationFlags]::None, [Security.AccessControl.AccessControlType]::Allow)
      $acl.AddAccessRule($rule)
    }
    try {
      Set-Acl -LiteralPath $path -AclObject $acl
    } catch {
      # Antivirus can hold the object open briefly; the caller retries once.
      throw 'set-acl-failed'
    }
  }
  $acl = if ($isDirectory) { [IO.Directory]::GetAccessControl($path) } else { [IO.File]::GetAccessControl($path) }
  # Elevated Windows processes create children owned by Administrators, already a trusted ACL principal.
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -notin @($sid.Value, 'S-1-5-32-544')) { throw 'owner-mismatch' }
  $rules = $acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])
  if ($rules.Count -eq 0) { throw 'missing-user-access' }
  $userAccess = $false
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -ne [Security.AccessControl.AccessControlType]::Allow) { throw 'foreign-ace' }
    if ($rule.IdentityReference.Value -notin @($sid.Value, 'S-1-5-18', 'S-1-5-32-544')) { throw 'foreign-ace' }
    if ($rule.IdentityReference.Value -eq $sid.Value -and ($rule.PropagationFlags -band [Security.AccessControl.PropagationFlags]::InheritOnly) -eq 0 -and ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::FullControl) -eq [Security.AccessControl.FileSystemRights]::FullControl) {
      if ($isDirectory -and $rule.PropagationFlags -ne [Security.AccessControl.PropagationFlags]::None) { throw 'foreign-ace' }
      if ($isDirectory -and ($rule.InheritanceFlags -band [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit') -ne [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit') { throw 'foreign-ace' }
      $userAccess = $true
    }
  }
  if (-not $userAccess) { throw 'missing-user-access' }
  if ($isDirectory) { [Console]::Out.Write('directory') } else { [Console]::Out.Write('file') }
} catch {
  # Print only an allowlisted reason; never the raw exception text (it may hold paths).
  $reason = $_.Exception.Message
  if ($reason -notin @('unsupported-volume', 'reparse-point', 'owner-mismatch', 'foreign-ace', 'missing-user-access', 'set-acl-failed')) {
    $reason = 'unexpected'
  }
  [Console]::Out.Write($reason)
  exit 1
}
`;
