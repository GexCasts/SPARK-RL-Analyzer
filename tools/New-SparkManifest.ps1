$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ManifestPath = Join-Path $Root "spark-manifest.json"
$RepoRawBase = "https://raw.githubusercontent.com/GexCasts/SPARK-RL-Analyzer/main"

$excludedDirectories = @(
  ".git",
  ".tmp",
  "tools\node"
)

$excludedFiles = @(
  "spark-manifest.json"
)

function Convert-ToRelativePath($Path) {
  $rootUri = New-Object System.Uri(($Root.TrimEnd("\") + "\"))
  $pathUri = New-Object System.Uri($Path)
  $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace("/", "\")
  return $relative.Replace("\", "/")
}

function Test-IsExcluded($Path) {
  $rootUri = New-Object System.Uri(($Root.TrimEnd("\") + "\"))
  $pathUri = New-Object System.Uri($Path)
  $relative = [System.Uri]::UnescapeDataString($rootUri.MakeRelativeUri($pathUri).ToString()).Replace("/", "\")
  foreach($directory in $excludedDirectories) {
    if($relative -eq $directory -or $relative.StartsWith("$directory\", [StringComparison]::OrdinalIgnoreCase)) {
      return $true
    }
  }
  foreach($file in $excludedFiles) {
    if($relative -ieq $file) {
      return $true
    }
  }
  return $false
}

$files = Get-ChildItem -LiteralPath $Root -Recurse -File |
  Where-Object { !(Test-IsExcluded $_.FullName) } |
  Sort-Object FullName |
  ForEach-Object {
    $hash = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    [pscustomobject]@{
      path = Convert-ToRelativePath $_.FullName
      version = $hash.Substring(0, 12)
      sha256 = $hash
      size = $_.Length
      modifiedUtc = $_.LastWriteTimeUtc.ToString("o")
    }
  }

$manifest = [ordered]@{
  schemaVersion = 1
  appName = "SPARK RL Analyzer"
  appVersion = (Get-Date).ToUniversalTime().ToString("yyyy.MM.dd.HHmm")
  generatedUtc = (Get-Date).ToUniversalTime().ToString("o")
  source = @{
    repository = "https://github.com/GexCasts/SPARK-RL-Analyzer"
    branch = "main"
    rawBaseUrl = $RepoRawBase
  }
  notes = "Generated from distributable SPARK files. Local .git, .tmp, and portable Node cache are intentionally excluded."
  files = $files
}

$json = $manifest | ConvertTo-Json -Depth 5
Set-Content -LiteralPath $ManifestPath -Value $json -Encoding UTF8
Write-Host "Wrote $ManifestPath with $($files.Count) files."
