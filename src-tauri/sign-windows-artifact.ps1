param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$FilePath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-SignTool {
  if ($env:DENDRO_SIGNTOOL_PATH) {
    if (Test-Path -LiteralPath $env:DENDRO_SIGNTOOL_PATH) {
      return (Resolve-Path -LiteralPath $env:DENDRO_SIGNTOOL_PATH).Path
    }
    throw "DENDRO_SIGNTOOL_PATH points to a missing file: $env:DENDRO_SIGNTOOL_PATH"
  }

  $kitsRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  if (Test-Path -LiteralPath $kitsRoot) {
    $candidate = Get-ChildItem -LiteralPath $kitsRoot -Recurse -Filter signtool.exe |
      Where-Object { $_.FullName -match '\\x64\\signtool\.exe$' } |
      Sort-Object FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw 'Could not find x64 signtool.exe. Install Windows SDK Build Tools or set DENDRO_SIGNTOOL_PATH.'
}

function Resolve-ArtifactSigningDlib {
  if ($env:DENDRO_ARTIFACT_SIGNING_DLIB_PATH) {
    if (Test-Path -LiteralPath $env:DENDRO_ARTIFACT_SIGNING_DLIB_PATH) {
      return (Resolve-Path -LiteralPath $env:DENDRO_ARTIFACT_SIGNING_DLIB_PATH).Path
    }
    throw "DENDRO_ARTIFACT_SIGNING_DLIB_PATH points to a missing file: $env:DENDRO_ARTIFACT_SIGNING_DLIB_PATH"
  }

  $searchRoots = @(
    (Join-Path ${env:ProgramFiles} 'Microsoft\ArtifactSigningClientTools'),
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\ArtifactSigningClientTools'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\MicrosoftArtifactSigningClientTools'),
    (Join-Path $env:USERPROFILE '.nuget\packages\microsoft.artifactsigning.client'),
    (Join-Path $env:USERPROFILE '.nuget\packages\microsoft.trusted.signing.client')
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) }

  foreach ($root in $searchRoots) {
    $candidate = Get-ChildItem -LiteralPath $root -Recurse -Filter Azure.CodeSigning.Dlib.dll |
      Sort-Object @{ Expression = { if ($_.FullName -match '\\x64\\|\\bin\\Azure\.CodeSigning\.Dlib\.dll$') { 0 } else { 1 } } }, FullName -Descending |
      Select-Object -First 1
    if ($candidate) {
      return $candidate.FullName
    }
  }

  throw 'Could not find x64 Azure.CodeSigning.Dlib.dll. Install Microsoft Artifact Signing Client Tools or set DENDRO_ARTIFACT_SIGNING_DLIB_PATH.'
}

$target = Resolve-Path -LiteralPath $FilePath
$metadataPath = if ($env:DENDRO_ARTIFACT_SIGNING_METADATA_PATH) {
  $env:DENDRO_ARTIFACT_SIGNING_METADATA_PATH
} else {
  Join-Path $PSScriptRoot 'artifact-signing.metadata.json'
}

if (!(Test-Path -LiteralPath $metadataPath)) {
  throw "Missing Artifact Signing metadata file: $metadataPath. Copy artifact-signing.metadata.sample.json to artifact-signing.metadata.json and fill in your Azure values."
}

$signTool = Resolve-SignTool
$dlib = Resolve-ArtifactSigningDlib
$timestampUrl = if ($env:DENDRO_TIMESTAMP_URL) { $env:DENDRO_TIMESTAMP_URL } else { 'http://timestamp.acs.microsoft.com' }

Write-Host "Signing $($target.Path)"
& $signTool sign `
  /v `
  /debug `
  /fd SHA256 `
  /tr $timestampUrl `
  /td SHA256 `
  /d 'DendroCapture' `
  /dlib $dlib `
  /dmdf $metadataPath `
  $target.Path

if ($LASTEXITCODE -ne 0) {
  throw "SignTool failed with exit code $LASTEXITCODE"
}

& $signTool verify /pa /tw /v $target.Path
if ($LASTEXITCODE -ne 0) {
  throw "SignTool verification failed with exit code $LASTEXITCODE"
}
