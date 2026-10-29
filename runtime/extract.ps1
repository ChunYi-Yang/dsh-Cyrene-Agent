param([Parameter(Mandatory=$true)][string]$Archive, [Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
[AppContext]::SetSwitch('Switch.System.IO.UseLegacyPathHandling', $false)
[AppContext]::SetSwitch('Switch.System.IO.BlockLongPaths', $false)
$root = [IO.Path]::GetFullPath($Destination).TrimEnd('\') + '\'
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
  $total = 0L
  $names = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
  if ($zip.Entries.Count -gt 60000) { throw 'Too many entries' }
  foreach ($entry in $zip.Entries) {
    $name = $entry.FullName.Replace('/', '\')
    if ($name.Contains(':') -or $name.StartsWith('\') -or $name.Split('\') -contains '..') { throw 'Unsafe archive path' }
    foreach ($segment in $name.TrimEnd('\').Split('\')) {
      if (-not $segment -or $segment -ne $segment.TrimEnd(' ','.') -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)') { throw 'Unsafe Windows filename' }
    }
    if (-not $names.Add($name)) { throw 'Duplicate archive entry' }
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $name))
    if (-not $target.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes destination' }
    if ((($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw 'Symbolic links are not supported' }
    $total += $entry.Length
    if ($total -gt 6GB) { throw 'Archive is too large' }
  }
  function LongPath([string]$path) { if ($path.StartsWith('\\?\')) { return $path }; return '\\?\' + $path }
  [IO.Directory]::CreateDirectory((LongPath $root)) | Out-Null
  foreach ($entry in $zip.Entries) {
    $target = [IO.Path]::GetFullPath([IO.Path]::Combine($root, $entry.FullName.Replace('/', '\')))
    if ($entry.FullName.EndsWith('/')) { [IO.Directory]::CreateDirectory((LongPath $target)) | Out-Null; continue }
    [IO.Directory]::CreateDirectory((LongPath ([IO.Path]::GetDirectoryName($target)))) | Out-Null
    [IO.Compression.ZipFileExtensions]::ExtractToFile($entry, (LongPath $target), $false)
  }
} finally { $zip.Dispose() }
