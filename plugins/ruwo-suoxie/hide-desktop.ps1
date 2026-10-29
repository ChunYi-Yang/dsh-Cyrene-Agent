param([Parameter(Mandatory=$true)][string]$Executable)
$ErrorActionPreference = 'Stop'
$targetExecutable = [IO.Path]::GetFullPath($Executable)
if ([IO.Path]::GetFileName($targetExecutable) -ne 'DeepSeek Harness.exe' -or -not (Test-Path -LiteralPath $targetExecutable -PathType Leaf)) {
  throw 'Installed DSH executable unavailable'
}
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class CyreneDesktopWindow {
  [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr window, int command);
}
'@
$hidden = $false
Get-Process -Name 'DeepSeek Harness' -ErrorAction SilentlyContinue | ForEach-Object {
  if ($_.MainWindowHandle -ne [IntPtr]::Zero -and [String]::Equals($_.Path, $targetExecutable, [StringComparison]::OrdinalIgnoreCase)) {
    if ([CyreneDesktopWindow]::ShowWindowAsync($_.MainWindowHandle, 0)) { $hidden = $true }
  }
}
if ($hidden) { 'hidden' } else { 'not-visible' }
