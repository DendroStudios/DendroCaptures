Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$root = Resolve-Path (Join-Path $PSScriptRoot '..')
$configPath = Join-Path $root 'src-tauri\tauri.conf.json'
$config = Get-Content -Raw -LiteralPath $configPath | ConvertFrom-Json
$version = [string]$config.version

$outDir = Join-Path $root 'dist-installer'
$installerName = "DendroCaptureInstaller_v$version.exe"
$installerPath = Join-Path $outDir $installerName
if (!(Test-Path -LiteralPath $installerPath)) {
  throw "Installer not found: $installerPath. Run npm.cmd run build:installer first."
}

$stagingDir = Join-Path $outDir "DendroCaptureInstaller_v$version"
$zipPath = Join-Path $outDir "DendroCaptureInstaller_v$version.zip"

if (Test-Path -LiteralPath $stagingDir) {
  Remove-Item -LiteralPath $stagingDir -Recurse -Force
}
if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}

New-Item -ItemType Directory -Path $stagingDir | Out-Null
Copy-Item -LiteralPath $installerPath -Destination (Join-Path $stagingDir $installerName)

@"
DendroCapture Installer

1. Extract this ZIP.
2. Run $installerName.

Windows may still warn about unsigned apps until DendroCapture is signed with a trusted code-signing certificate and builds SmartScreen reputation.
"@ | Set-Content -LiteralPath (Join-Path $stagingDir 'README.txt') -Encoding ASCII

Compress-Archive -Path (Join-Path $stagingDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
if (!(Test-Path -LiteralPath $zipPath)) {
  throw "ZIP was not created: $zipPath"
}
Remove-Item -LiteralPath $stagingDir -Recurse -Force

Write-Host "Installer ZIP ready: $zipPath"
