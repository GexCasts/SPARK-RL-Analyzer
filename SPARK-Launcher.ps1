$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir = Join-Path $Root "tools"
$NodeVersion = "v22.11.0"
$NodeFolder = "node-$NodeVersion-win-x64"
$NodeZip = Join-Path $ToolsDir "$NodeFolder.zip"
$BundledNode = Join-Path $ToolsDir "node\$NodeFolder\node.exe"
$RrrocketVersion = "0.11.1"
$RrrocketFolder = "rrrocket-$RrrocketVersion-x86_64-pc-windows-msvc"
$RrrocketZip = Join-Path $ToolsDir "rrrocket\$RrrocketFolder.zip"
$RrrocketExe = Join-Path $ToolsDir "rrrocket\$RrrocketFolder\rrrocket.exe"
$ServerScript = Join-Path $Root "static-download-server.mjs"
$AppUrl = "http://127.0.0.1:8765/"
$TmpDir = Join-Path $Root ".tmp"
$ServerOutLog = Join-Path $TmpDir "spark-server.out.log"
$ServerErrLog = Join-Path $TmpDir "spark-server.err.log"

function Write-Step($Message) {
  Write-Host "[SPARK] $Message"
}

function Download-File($Url, $Destination) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Step "Downloading $Url"
  Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
}

function Expand-Zip($ZipPath, $Destination) {
  if(Test-Path $Destination) {
    Remove-Item -LiteralPath $Destination -Recurse -Force
  }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Resolve-Node {
  if(Test-Path $BundledNode) {
    return $BundledNode
  }

  $SystemNode = Get-Command node -ErrorAction SilentlyContinue
  if($SystemNode) {
    return $SystemNode.Source
  }

  Write-Step "Node.js was not found. Installing a portable runtime into tools\\node..."
  Download-File "https://nodejs.org/dist/$NodeVersion/$NodeFolder.zip" $NodeZip
  Expand-Zip $NodeZip (Join-Path $ToolsDir "node")
  Remove-Item -LiteralPath $NodeZip -Force -ErrorAction SilentlyContinue

  if(!(Test-Path $BundledNode)) {
    throw "Portable Node install failed. Expected $BundledNode"
  }

  return $BundledNode
}

function Ensure-Rrrocket {
  if(Test-Path $RrrocketExe) {
    return
  }

  Write-Step "rrrocket parser was not found. Installing parser into tools\\rrrocket..."
  Download-File "https://github.com/nickbabcock/rrrocket/releases/download/v$RrrocketVersion/$RrrocketFolder.zip" $RrrocketZip
  Expand-Zip $RrrocketZip (Join-Path $ToolsDir "rrrocket")
  Remove-Item -LiteralPath $RrrocketZip -Force -ErrorAction SilentlyContinue

  if(!(Test-Path $RrrocketExe)) {
    throw "rrrocket install failed. Expected $RrrocketExe"
  }
}

function Test-Server {
  try {
    $Response = Invoke-WebRequest -Uri $AppUrl -UseBasicParsing -TimeoutSec 2
    return $Response.StatusCode -eq 200
  } catch {
    return $false
  }
}

Write-Step "Preparing local parser server..."
New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
Ensure-Rrrocket
$NodeExe = Resolve-Node

if(!(Test-Path $ServerScript)) {
  throw "Missing static-download-server.mjs next to this launcher."
}

if(!(Test-Server)) {
  Write-Step "Starting local server on 127.0.0.1:8765..."
  New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
  Remove-Item -LiteralPath $ServerOutLog, $ServerErrLog -Force -ErrorAction SilentlyContinue
  $ServerProcess = Start-Process `
    -FilePath $NodeExe `
    -ArgumentList @("`"$ServerScript`"") `
    -WorkingDirectory $Root `
    -WindowStyle Hidden `
    -RedirectStandardOutput $ServerOutLog `
    -RedirectStandardError $ServerErrLog `
    -PassThru

  $Ready = $false
  for($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 250
    if($ServerProcess.HasExited) {
      break
    }
    if(Test-Server) {
      $Ready = $true
      break
    }
  }

  if(!$Ready) {
    $ErrorText = ""
    if(Test-Path $ServerErrLog) {
      $ErrorText = (Get-Content -LiteralPath $ServerErrLog -Raw -ErrorAction SilentlyContinue).Trim()
    }
    if(!$ErrorText -and (Test-Path $ServerOutLog)) {
      $ErrorText = (Get-Content -LiteralPath $ServerOutLog -Raw -ErrorAction SilentlyContinue).Trim()
    }
    if($ErrorText) {
      throw "The local server did not respond on 127.0.0.1:8765. Server log: $ErrorText"
    }
    throw "The local server did not respond on 127.0.0.1:8765."
  }
} else {
  Write-Step "Local server is already running."
}

Write-Step "Opening SPARK..."
Start-Process $AppUrl
Write-Step "Ready. Keep this folder intact; close the hidden node.exe process from Task Manager if you need to stop the server."
