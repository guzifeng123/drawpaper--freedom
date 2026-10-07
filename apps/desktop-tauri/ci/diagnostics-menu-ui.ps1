<#
.SYNOPSIS
  Wave18 P4b (best-effort): drive the native 帮助 -> 导出诊断信息… save dialog via
  SendKeys, then assert the produced zip contains system.json and NO *.kbnote.

.DESCRIPTION
  Self-contained; CI step is `continue-on-error: true`. Hand-run:

      pwsh -NoProfile -ExecutionPolicy Bypass -File .\diagnostics-menu-ui.ps1

  Method:
    1. Launch the installed app, bounded-wait for its main window.
    2. SendKeys: Alt -> Right x5 (..帮助 dropdown) -> Down x3 -> Enter
       = 帮助/导出诊断信息… (dropdown items: 关于=1, 检查更新=2, 打开数据目录=3,
       导出诊断信息…=4).
    3. Wait for the native Save dialog, then SendKeys the temp .zip path + Enter.
    4. Bounded-wait 40s for the zip; Expand-Archive; assert
       system.json exists and zero *.kbnote entries.
    5. finally: kill drawpaper.

  Exit codes:
    0 = zip produced and assertions held (best-effort PASS) OR graceful SKIP.
    1 = FAIL: window never booted / zip never appeared / assertion violated.
  Native-dialog focus on hosted runners is flaky by design; the CI step stays
  amber (never red-blocking) and prints the full log for manual triage.
#>
param(
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Continue'

function Resolve-DrawpaperExe([string]$hint) {
  if ($hint -and (Test-Path $hint)) { return $hint }
  $candidates = @(
    (Join-Path $env:LOCALAPPDATA 'Programs\drawpaper\drawpaper.exe'),
    (Join-Path $env:LOCALAPPDATA 'drawpaper\drawpaper.exe'),
    (Join-Path $env:ProgramFiles 'drawpaper\drawpaper.exe')
  )
  if (${env:ProgramFiles(x86)}) { $candidates += (Join-Path ${env:ProgramFiles(x86)} 'drawpaper\drawpaper.exe') }
  foreach ($c in $candidates) { if (Test-Path $c) { return $c } }
  foreach ($root in @((Join-Path $env:LOCALAPPDATA 'Programs'), $env:ProgramFiles, ${env:ProgramFiles(x86)})) {
    if ($root -and (Test-Path $root)) {
      $hit = Get-ChildItem $root -Filter 'drawpaper' -Directory -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($hit) { $exe = Join-Path $hit.FullName 'drawpaper.exe'; if (Test-Path $exe) { return $exe } }
    }
  }
  return $null
}

$exe = Resolve-DrawpaperExe $ExePath
if (-not $exe) {
  Write-Host "::SKIP::drawpaper.exe not found in install candidates; P4b aborted (not a failure)"
  exit 0
}
Write-Host "drawpaper.exe = $exe"

$outZip = Join-Path $env:TEMP ('dp-diag-menu-' + [guid]::NewGuid().ToString('N') + '.zip')
Remove-Item $outZip -ErrorAction SilentlyContinue

Get-Process drawpaper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

try {
  Write-Host "Launching app"
  $proc = Start-Process -FilePath $exe -PassThru
  $booted = $false
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    $proc.Refresh()
    if ($proc.HasExited) { break }
    $p = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($p -and $p.MainWindowTitle) { $booted = $true; break }
  }
  if (-not $booted) {
    Write-Host "::FAIL::app window never appeared within 60s (headless desktop?); cannot drive native menu/dialog"
    exit 1
  }
  Write-Host "App booted, main window title = '$((Get-Process -Id $proc.Id).MainWindowTitle)'"
  Start-Sleep -Seconds 8

  # Drive 帮助 -> 导出诊断信息…
  Add-Type -AssemblyName System.Windows.Forms
  $wsh = New-Object -ComObject WScript.Shell
  $activated = $wsh.AppActivate($proc.Id)
  Write-Host "AppActivate(pid=$($proc.Id)) = $activated"
  Start-Sleep -Seconds 1
  [System.Windows.Forms.SendKeys]::SendWait('%')
  Start-Sleep -Milliseconds 500
  foreach ($n in 1..5) { [System.Windows.Forms.SendKeys]::SendWait('{RIGHT}'); Start-Sleep -Milliseconds 300 }
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')  # 关于
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')  # 检查更新…
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')  # 打开数据目录
  Start-Sleep -Milliseconds 250
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')  # 导出诊断信息…
  Start-Sleep -Milliseconds 400
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Host 'Sent keys: Alt -> Right x5 -> Down x4 -> Enter  (intends: 帮助 -> 导出诊断信息…)'

  # Give the native Save dialog time to come up, then type the target path and
  # confirm. SendKeys special chars ( + ^ % ~ ( ) { } ) are NOT present in this path.
  Start-Sleep -Seconds 3
  [System.Windows.Forms.SendKeys]::SendWait($outZip)
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Host "Sent zip path: $outZip"

  # Bounded wait for the zip to appear (collection ~1-3s once dialog confirms).
  $zipSeen = $false
  for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $outZip) { $zipSeen = $true; break }
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Host "::FAIL::drawpaper process exited while waiting for the diag zip"
      exit 1
    }
  }
  if (-not $zipSeen) {
    Write-Host "::FAIL::diag zip ($outZip) never appeared in 40s — menu/dialog SendKeys likely missed focus"
    exit 1
  }
  $len = (Get-Item $outZip).Length
  Write-Host "diag zip produced: $outZip ($len bytes)"
  if ($len -lt 100) { Write-Host "::FAIL::zip implausibly small"; exit 1 }

  $extract = Join-Path $env:TEMP ('dp-diag-menu-x-' + [guid]::NewGuid().ToString('N'))
  Remove-Item $extract -Recurse -Force -ErrorAction SilentlyContinue
  Expand-Archive -Path $outZip -DestinationPath $extract -Force -ErrorAction Stop
  Write-Host "::group::diag zip entries"
  Get-ChildItem $extract -Recurse -File | ForEach-Object {
    Write-Host ("  - {0}  ({1} bytes)" -f $_.FullName.Substring($extract.Length + 1), $_.Length)
  }
  Write-Host "::endgroup::"

  if (-not (Test-Path (Join-Path $extract 'system.json'))) {
    Write-Host "::FAIL::system.json missing from menu-exported diag zip"
    exit 1
  }
  $leak = Get-ChildItem $extract -Recurse -File -Filter '*.kbnote' -ErrorAction SilentlyContinue
  if ($leak) {
    $leak | ForEach-Object { Write-Host "LEAK: $($_.FullName)" }
    Write-Host "::FAIL::menu-exported diag zip contains a *.kbnote entry"
    exit 1
  }
  Write-Host "PASS(best-effort): 导出诊断信息… menu flow produced zip with system.json and zero *.kbnote"
  exit 0
}
finally {
  Get-Process drawpaper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  Get-Process msedgewebview2 -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
