param([Parameter(Mandatory=$true)][string]$Source,[Parameter(Mandatory=$true)][string]$Destination)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
if (Test-Path -LiteralPath $Destination) { throw 'Archive already exists; choose a new release version' }
[IO.Compression.ZipFile]::CreateFromDirectory([IO.Path]::GetFullPath($Source),[IO.Path]::GetFullPath($Destination),[IO.Compression.CompressionLevel]::Optimal,$false)
