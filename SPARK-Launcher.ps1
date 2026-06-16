$ErrorActionPreference = "Stop"

if([Threading.Thread]::CurrentThread.GetApartmentState() -ne "STA") {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "powershell.exe"
  $psi.Arguments = "-STA -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $psi.WorkingDirectory = Split-Path -Parent $PSCommandPath
  $psi.UseShellExecute = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden
  [Diagnostics.Process]::Start($psi) | Out-Null
  exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ToolsDir = Join-Path $Root "tools"
$TmpDir = Join-Path $Root ".tmp"
$DependencyDownloadDir = Join-Path $TmpDir "downloads"
$NodeVersion = "v22.11.0"
$NodeFolder = "node-$NodeVersion-win-x64"
$NodeZip = Join-Path $DependencyDownloadDir "$NodeFolder.zip"
$BundledNode = Join-Path $ToolsDir "node\$NodeFolder\node.exe"
$RrrocketVersion = "0.11.3"
$RrrocketFolder = "rrrocket-$RrrocketVersion-x86_64-pc-windows-msvc"
$RrrocketZip = Join-Path $DependencyDownloadDir "$RrrocketFolder.zip"
$RrrocketExe = Join-Path $ToolsDir "rrrocket\$RrrocketFolder\rrrocket.exe"
$FfmpegVersion = "8.1.1"
$FfmpegFolder = "ffmpeg-$FfmpegVersion-essentials_build"
$FfmpegZip = Join-Path $DependencyDownloadDir "$FfmpegFolder.zip"
$FfmpegExe = Join-Path $ToolsDir "ffmpeg\$FfmpegFolder\bin\ffmpeg.exe"
$ServerScript = Join-Path $Root "static-download-server.mjs"
$AppUrl = "http://127.0.0.1:8765/SPARK.html"
$ServerOutLog = Join-Path $TmpDir "spark-server.out.log"
$ServerErrLog = Join-Path $TmpDir "spark-server.err.log"
$ManifestPath = Join-Path $Root "spark-manifest.json"
$GithubRawBase = "https://raw.githubusercontent.com/GexCasts/SPARK-RL-Analyzer/main"
$SparkLogoPath = Join-Path $Root "assets\SPARK app logo transparent.png"
$OneNeLogoPath = Join-Path $Root "assets\1NE_Vector_edited.png"

$script:StatusBox = $null
$script:LaunchButton = $null
$script:UpdateButton = $null
$script:ProgressBar = $null

function Write-Status($Message) {
  if($script:StatusBox) {
    $script:StatusBox.AppendText("[SPARK] $Message`r`n")
    $script:StatusBox.SelectionStart = $script:StatusBox.Text.Length
    $script:StatusBox.ScrollToCaret()
    [System.Windows.Forms.Application]::DoEvents()
  }
  Write-Host "[SPARK] $Message"
}

function Set-LauncherProgress($Value) {
  if($script:ProgressBar) {
    $clamped = [Math]::Max(0, [Math]::Min(100, [int]$Value))
    $script:ProgressBar.Value = $clamped
    [System.Windows.Forms.Application]::DoEvents()
  }
}

function Download-File($Url, $Destination) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Write-Status "Downloading $Url"
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

  Write-Status "Node.js was not found. Installing a portable runtime into tools\node..."
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

  Write-Status "rrrocket parser was not found. Installing parser into tools\rrrocket..."
  Download-File "https://github.com/nickbabcock/rrrocket/releases/download/v$RrrocketVersion/$RrrocketFolder.zip" $RrrocketZip
  Expand-Zip $RrrocketZip (Join-Path $ToolsDir "rrrocket")
  Remove-Item -LiteralPath $RrrocketZip -Force -ErrorAction SilentlyContinue

  if(!(Test-Path $RrrocketExe)) {
    throw "rrrocket install failed. Expected $RrrocketExe"
  }
}

function Ensure-Ffmpeg {
  if(Test-Path $FfmpegExe) {
    return
  }

  Write-Status "FFmpeg was not found. Installing video conversion support into tools\ffmpeg..."
  Download-File "https://github.com/GyanD/codexffmpeg/releases/download/$FfmpegVersion/$FfmpegFolder.zip" $FfmpegZip
  Expand-Zip $FfmpegZip (Join-Path $ToolsDir "ffmpeg")
  Remove-Item -LiteralPath $FfmpegZip -Force -ErrorAction SilentlyContinue

  if(!(Test-Path $FfmpegExe)) {
    throw "FFmpeg install failed. Expected $FfmpegExe"
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

function Resolve-AppModeBrowser {
  $programFilesX86 = ${env:ProgramFiles(x86)}
  $candidates = @(
    (Join-Path $programFilesX86 "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:LOCALAPPDATA "Microsoft\Edge\Application\msedge.exe"),
    (Join-Path $env:ProgramFiles "Google\Chrome\Application\chrome.exe"),
    (Join-Path $programFilesX86 "Google\Chrome\Application\chrome.exe"),
    (Join-Path $env:LOCALAPPDATA "Google\Chrome\Application\chrome.exe")
  )
  return $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1
}

function Open-SparkAppWindow {
  $browser = Resolve-AppModeBrowser
  if($browser) {
    Start-Process -FilePath $browser -ArgumentList @("--app=$AppUrl","--new-window")
    Write-Status "Opening SPARK in app window mode..."
    return
  }
  Start-Process $AppUrl
  Write-Status "Opening SPARK in your default browser..."
}

function Start-SPARK {
  Set-LauncherProgress 4
  Write-Status "Preparing local parser server..."
  New-Item -ItemType Directory -Force -Path $ToolsDir | Out-Null
  Set-LauncherProgress 14
  Ensure-Rrrocket
  Set-LauncherProgress 24
  Ensure-Ffmpeg
  Set-LauncherProgress 34
  $NodeExe = Resolve-Node
  Set-LauncherProgress 44

  if(!(Test-Path $ServerScript)) {
    throw "Missing static-download-server.mjs next to this launcher."
  }

  Set-LauncherProgress 54
  if(!(Test-Server)) {
    Write-Status "Starting local server on 127.0.0.1:8765..."
    Set-LauncherProgress 64
    New-Item -ItemType Directory -Force -Path $TmpDir | Out-Null
    Remove-Item -LiteralPath $ServerOutLog, $ServerErrLog -Force -ErrorAction SilentlyContinue
    $env:SPARK_RRROCKET_PATH = $RrrocketExe
    $env:SPARK_FFMPEG_PATH = $FfmpegExe
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
      Set-LauncherProgress (64 + [Math]::Min(26, [int](($i + 1) * 0.65)))
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
    Write-Status "Local server is already running."
    Set-LauncherProgress 90
  }

  Write-Status "Opening SPARK..."
  Set-LauncherProgress 96
  Open-SparkAppWindow
  Write-Status "Ready. Closing the main SPARK window shuts down the local server."
  Set-LauncherProgress 100
}

function ConvertFrom-ManifestJson($JsonText) {
  $cleanJson = [string]$JsonText
  $cleanJson = $cleanJson.TrimStart([char]0xFEFF)
  return $cleanJson | ConvertFrom-Json
}

function Get-LocalFileSha256($Path) {
  if(!(Test-Path $Path)) {
    return $null
  }
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-ShortHash($Hash) {
  if([string]::IsNullOrWhiteSpace($Hash)) {
    return "missing"
  }
  $clean = ([string]$Hash).Trim()
  if($clean.Length -le 12) {
    return $clean
  }
  return $clean.Substring(0, 12)
}

function Join-SafeManifestPath($RelativePath) {
  if([string]::IsNullOrWhiteSpace($RelativePath)) {
    throw "Manifest contains an empty file path."
  }
  $normalized = $RelativePath.Replace("/", "\")
  if([IO.Path]::IsPathRooted($normalized) -or $normalized.Contains("..\")) {
    throw "Manifest contains an unsafe file path: $RelativePath"
  }
  return Join-Path $Root $normalized
}

function Get-RemoteManifest {
  $cacheBust = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
  $url = "$GithubRawBase/spark-manifest.json?cache=$cacheBust"
  Set-LauncherProgress 8
  Write-Status "Checking GitHub manifest..."
  return ConvertFrom-ManifestJson (Invoke-WebRequest -Uri $url -UseBasicParsing).Content
}

function Get-LocalManifest {
  if(!(Test-Path $ManifestPath)) {
    return $null
  }
  return ConvertFrom-ManifestJson (Get-Content -LiteralPath $ManifestPath -Raw)
}

function Update-SPARKFromManifest {
  Set-LauncherProgress 4
  $remoteManifest = Get-RemoteManifest
  Set-LauncherProgress 18
  $localManifest = Get-LocalManifest
  if($remoteManifest.files.Count -lt 1) {
    throw "The remote manifest did not list any files."
  }

  $changed = New-Object System.Collections.Generic.List[object]
  $checked = 0
  foreach($file in $remoteManifest.files) {
    $checked++
    Set-LauncherProgress (18 + [Math]::Min(22, [int](($checked / [Math]::Max(1, $remoteManifest.files.Count)) * 22)))
    $relative = [string]$file.path
    $target = Join-SafeManifestPath $relative
    $remoteHash = ([string]$file.sha256).ToLowerInvariant()
    $localHash = Get-LocalFileSha256 $target
    if($localHash -ne $remoteHash) {
      $changed.Add($file)
    }
  }

  if($changed.Count -eq 0) {
    Write-Status "SPARK is already up to date."
    Set-LauncherProgress 100
    return
  }

  Write-Status "Found $($changed.Count) file(s) to update."
  $downloaded = 0
  foreach($file in $changed) {
    $downloaded++
    Set-LauncherProgress (40 + [Math]::Min(50, [int](($downloaded / [Math]::Max(1, $changed.Count)) * 50)))
    $relative = [string]$file.path
    $target = Join-SafeManifestPath $relative
    $downloadPath = Join-Path $TmpDir ("update-" + [Guid]::NewGuid().ToString("N"))
    $urlPath = ($relative -replace "\\","/").Split("/") | ForEach-Object { [uri]::EscapeDataString($_) }
    $url = "$GithubRawBase/" + ($urlPath -join "/")
    Download-File $url $downloadPath
    $downloadHash = Get-LocalFileSha256 $downloadPath
    $expectedHash = ([string]$file.sha256).ToLowerInvariant()
    if($downloadHash -ne $expectedHash) {
      Remove-Item -LiteralPath $downloadPath -Force -ErrorAction SilentlyContinue
      throw "Downloaded file failed hash check: $relative (expected $(Get-ShortHash $expectedHash), got $(Get-ShortHash $downloadHash))"
    }
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $target) | Out-Null
    Move-Item -LiteralPath $downloadPath -Destination $target -Force
    Write-Status "Updated $relative"
  }

  $manifestDownload = Join-Path $TmpDir ("update-manifest-" + [Guid]::NewGuid().ToString("N") + ".json")
  Set-LauncherProgress 94
  Download-File "$GithubRawBase/spark-manifest.json" $manifestDownload
  Move-Item -LiteralPath $manifestDownload -Destination $ManifestPath -Force

  if($localManifest -and $localManifest.appVersion -ne $remoteManifest.appVersion) {
    Write-Status "Updated SPARK from $($localManifest.appVersion) to $($remoteManifest.appVersion)."
  } else {
    Write-Status "Update complete."
  }
  Set-LauncherProgress 100
}

function Set-ButtonsEnabled($Enabled) {
  if($script:LaunchButton) { $script:LaunchButton.Enabled = $Enabled }
  if($script:UpdateButton) { $script:UpdateButton.Enabled = $Enabled }
}

function New-Label($Text, $X, $Y, $Width, $Height, $Size, $Color, $Bold = $false) {
  $label = New-Object System.Windows.Forms.Label
  $label.Text = $Text
  $label.Location = New-Object System.Drawing.Point($X, $Y)
  $label.Size = New-Object System.Drawing.Size($Width, $Height)
  $style = if($Bold) { [System.Drawing.FontStyle]::Bold } else { [System.Drawing.FontStyle]::Regular }
  $label.Font = New-Object System.Drawing.Font("Segoe UI", $Size, $style)
  $label.ForeColor = $Color
  $label.BackColor = [System.Drawing.Color]::Transparent
  return $label
}

function New-Button($Text, $X, $Y, $Width, $Height, $BackColor) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $Text
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($Width, $Height)
  $button.Font = New-Object System.Drawing.Font("Segoe UI Semibold", 10)
  $button.FlatStyle = [System.Windows.Forms.FlatStyle]::Flat
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = $BackColor
  $button.ForeColor = [System.Drawing.Color]::White
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  return $button
}

function Load-ImageCopy($Path) {
  $source = [System.Drawing.Image]::FromFile($Path)
  try {
    return New-Object System.Drawing.Bitmap($source)
  } finally {
    $source.Dispose()
  }
}

function Load-IconCopy($Path) {
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $icon = New-Object System.Drawing.Icon($stream)
    return $icon.Clone()
  } finally {
    $stream.Dispose()
  }
}

function Show-SPARKLauncher {
  [System.Windows.Forms.Application]::EnableVisualStyles()

  $bg = [System.Drawing.Color]::FromArgb(243, 244, 246)
  $ink = [System.Drawing.Color]::FromArgb(24, 24, 27)
  $muted = [System.Drawing.Color]::FromArgb(82, 82, 91)
  $yellow = [System.Drawing.Color]::FromArgb(245, 178, 20)
  $black = [System.Drawing.Color]::FromArgb(28, 28, 30)
  $blue = [System.Drawing.Color]::FromArgb(0, 120, 212)
  $silver = [System.Drawing.Color]::FromArgb(150, 153, 158)

  $form = New-Object System.Windows.Forms.Form
  $form.Text = "SPARK Launcher"
  $form.StartPosition = "CenterScreen"
  $form.ClientSize = New-Object System.Drawing.Size(620, 500)
  $form.MinimumSize = New-Object System.Drawing.Size(620, 500)
  $form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedSingle
  $form.MaximizeBox = $false
  $form.BackColor = $bg
  if(Test-Path (Join-Path $Root "assets\SPARK Launcher.ico")) {
    $form.Icon = Load-IconCopy (Join-Path $Root "assets\SPARK Launcher.ico")
  }

  $hero = New-Object System.Windows.Forms.Panel
  $hero.Location = New-Object System.Drawing.Point(18, 18)
  $hero.Size = New-Object System.Drawing.Size(584, 170)
  $hero.BackColor = [System.Drawing.Color]::White
  $hero.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $form.Controls.Add($hero)

  if(Test-Path $SparkLogoPath) {
    $sparkLogo = New-Object System.Windows.Forms.PictureBox
    $sparkLogo.Image = Load-ImageCopy $SparkLogoPath
    $sparkLogo.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
    $sparkLogo.Location = New-Object System.Drawing.Point(22, 20)
    $sparkLogo.Size = New-Object System.Drawing.Size(145, 105)
    $sparkLogo.BackColor = [System.Drawing.Color]::Transparent
    $hero.Controls.Add($sparkLogo)
  }

  $hero.Controls.Add((New-Label "SPARK" 188 32 340 38 22 $ink $true))
  $hero.Controls.Add((New-Label "Statistical Performance Analysis Replay Kit" 190 76 360 42 10.5 $muted $false))

  $madeBy = New-Object System.Windows.Forms.Panel
  $madeBy.Location = New-Object System.Drawing.Point(380, 115)
  $madeBy.Size = New-Object System.Drawing.Size(180, 42)
  $madeBy.BackColor = [System.Drawing.Color]::White
  $madeBy.BorderStyle = [System.Windows.Forms.BorderStyle]::None
  $hero.Controls.Add($madeBy)
  $madeBy.Controls.Add((New-Label "made by" 10 12 58 18 8.5 $muted $false))
  if(Test-Path $OneNeLogoPath) {
    $oneNe = New-Object System.Windows.Forms.PictureBox
    $oneNe.Image = Load-ImageCopy $OneNeLogoPath
    $oneNe.SizeMode = [System.Windows.Forms.PictureBoxSizeMode]::Zoom
    $oneNe.Location = New-Object System.Drawing.Point(76, 2)
    $oneNe.Size = New-Object System.Drawing.Size(78, 38)
    $oneNe.BackColor = [System.Drawing.Color]::Transparent
    $madeBy.Controls.Add($oneNe)
  }

  $script:LaunchButton = New-Button "Launch SPARK" 18 210 282 46 $yellow
  $script:UpdateButton = New-Button "Check for Updates" 320 210 282 46 $silver
  $form.Controls.Add($script:LaunchButton)
  $form.Controls.Add($script:UpdateButton)

  $script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
  $script:ProgressBar.Location = New-Object System.Drawing.Point(18, 268)
  $script:ProgressBar.Size = New-Object System.Drawing.Size(584, 10)
  $script:ProgressBar.Style = [System.Windows.Forms.ProgressBarStyle]::Continuous
  $script:ProgressBar.Minimum = 0
  $script:ProgressBar.Maximum = 100
  $script:ProgressBar.Value = 0
  $form.Controls.Add($script:ProgressBar)

  $script:StatusBox = New-Object System.Windows.Forms.TextBox
  $script:StatusBox.Location = New-Object System.Drawing.Point(18, 292)
  $script:StatusBox.Size = New-Object System.Drawing.Size(584, 160)
  $script:StatusBox.Multiline = $true
  $script:StatusBox.ReadOnly = $true
  $script:StatusBox.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical
  $script:StatusBox.BorderStyle = [System.Windows.Forms.BorderStyle]::FixedSingle
  $script:StatusBox.Font = New-Object System.Drawing.Font("Consolas", 9)
  $script:StatusBox.BackColor = [System.Drawing.Color]::FromArgb(31, 31, 35)
  $script:StatusBox.ForeColor = [System.Drawing.Color]::FromArgb(245, 245, 245)
  $form.Controls.Add($script:StatusBox)

  $manifestLabel = New-Label "Manifest updates compare local SHA-256 versions with GitHub main." 20 462 410 20 8.5 $muted $false
  $form.Controls.Add($manifestLabel)

  if(Test-Path $ManifestPath) {
    try {
      $manifest = Get-LocalManifest
      Write-Status "Local manifest: $($manifest.appVersion), $($manifest.files.Count) tracked files."
    } catch {
      Write-Status "Local manifest is present but could not be read."
    }
  } else {
    Write-Status "No local manifest found yet."
  }

  $script:LaunchButton.Add_Click({
    try {
      Set-ButtonsEnabled $false
      Set-LauncherProgress 0
      Start-SPARK
    } catch {
      Set-LauncherProgress 0
      Write-Status $_.Exception.Message
      [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "SPARK Launcher", "OK", "Error") | Out-Null
    } finally {
      Set-ButtonsEnabled $true
    }
  })

  $script:UpdateButton.Add_Click({
    try {
      Set-ButtonsEnabled $false
      Set-LauncherProgress 0
      Update-SPARKFromManifest
    } catch {
      Set-LauncherProgress 0
      Write-Status $_.Exception.Message
      [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, "SPARK Launcher", "OK", "Error") | Out-Null
    } finally {
      Set-ButtonsEnabled $true
    }
  })

  [System.Windows.Forms.Application]::Run($form)
}

Show-SPARKLauncher
