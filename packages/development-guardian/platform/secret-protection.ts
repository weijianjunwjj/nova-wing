import { execFile } from 'node:child_process'
import { chmod, lstat, mkdir } from 'node:fs/promises'
import { promisify } from 'node:util'

export function secretProtectionStrategy(platform: NodeJS.Platform = process.platform): 'windows-acl' | 'posix-mode' {
  if (platform === 'win32') return 'windows-acl'
  if (platform === 'darwin' || platform === 'linux') return 'posix-mode'
  throw new Error('Secure local secret storage is unavailable on this platform')
}

/** Exact protected DACL: no inherited or pre-existing broad grants survive. */
export async function restrictWindowsSecretFileAcl(path: string): Promise<void> {
  if (process.platform !== 'win32') throw new Error('Windows ACL adapter invoked on another platform')
  const script = [
    "$ErrorActionPreference = 'Stop'",
    '$p = $env:NOVAWING_SECRET_ACL_TARGET',
    '$item = Get-Item -LiteralPath $p -Force',
    'if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw "Reparse point refused" }',
    '$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User',
    '$acl = if ($item.PSIsContainer) { New-Object Security.AccessControl.DirectorySecurity } else { New-Object Security.AccessControl.FileSecurity }',
    '$acl.SetOwner($sid)',
    '$acl.SetAccessRuleProtection($true, $false)',
    '$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, "FullControl", "Allow")',
    '$acl.AddAccessRule($rule)',
    'Set-Acl -LiteralPath $p -AclObject $acl',
    '$actual = Get-Acl -LiteralPath $p',
    'if (-not $actual.AreAccessRulesProtected) { throw "ACL inheritance remains" }',
    '$rules = $actual.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier])',
    'if ($rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne "Allow" -or $rules[0].FileSystemRights -ne "FullControl") { throw "ACL verification failed" }',
  ].join('; ')
  try {
    await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
      env: { ...process.env, NOVAWING_SECRET_ACL_TARGET: path }, shell: false, windowsHide: true, timeout: 10_000,
    })
  } catch { throw new Error('failed to secure local SMTP secrets with Windows ACL') }
}

export async function assertPrivateSecretPath(path: string, directory = false): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Unsafe local secret path')
  if (secretProtectionStrategy() === 'posix-mode' &&
      ((info.mode & 0o777) !== (directory ? 0o700 : 0o600) || info.uid !== process.getuid?.())) {
    throw new Error('Local secret permissions or owner are unsafe')
  }
}

export async function protectSecretPath(path: string, directory = false): Promise<void> {
  const info = await lstat(path)
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile())) throw new Error('Unsafe local secret path')
  if (secretProtectionStrategy() === 'windows-acl') await restrictWindowsSecretFileAcl(path)
  else {
    if (info.uid !== process.getuid?.()) throw new Error('Local secret owner is unsafe')
    await chmod(path, directory ? 0o700 : 0o600)
  }
  await assertPrivateSecretPath(path, directory)
}

export async function prepareSecretDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 })
  await protectSecretPath(path, true)
}
