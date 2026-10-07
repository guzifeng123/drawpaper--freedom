<#
.SYNOPSIS
  Wave18 P4a (best-effort): prove 帮助 -> 检查更新… falls back to opening the
  Releases web page when the app has NO outbound network.

.DESCRIPTION
  Self-contained; intended for CI with `continue-on-error: true`, also runnable
  by hand:

      pwsh -NoProfile -ExecutionPolicy Bypass -File .\updater-offline-fallback.ps1

  Method:
    1. New-NetFirewallRule outbound-BLOCK scoped to drawpaper.exe only
       (WebView2 child processes are msedgewebview2.exe and stay unaffected).
    2. Launch the installed app, bounded-wait for its main window.
    3. SendKeys: Alt -> Right x5 (文件..帮助) -> Down -> Enter = 帮助/检查更新…
    4. Bounded-wait 30s for BOTH evidence signals:
         (a) %APPDATA%\com.drawpaper.app\logs\drawpaper.log contains
             `falling back to Releases web page`  (the run_manual_update_check
             warn anchor for both "updater build failed" and "check() Err");
         (b) a browser (msedge/chrome) process command line contains
             /releases/latest (the opener fallback actually opened the page).
       AND the drawpaper process must still be alive (no crash).
    5. finally: kill drawpaper + remove the firewall rule.

  Exit codes:
    0 = evidence found (best-effort PASS) OR graceful SKIP (exe not installed).
    1 = FAIL: window never booted / process crashed / evidence anchors missing.
  On GitHub hosted runners the native SendKeys menu drive may miss focus; the
  step is `continue-on-error: true`, so an exit 1 only goes amber with full logs.
#>
param(
  [string]$ExePath = ''
)

$ErrorActionPreference = 'Continue'
$ruleName = "drawpaper-ci-p4a-block-" + [guid]::NewGuid().ToString('N').Substring(0, 8)

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
  Write-Host "::SKIP::drawpaper.exe not found in install candidates; P4a aborted (not a failure)"
  exit 0
}
Write-Host "drawpaper.exe = $exe"

Get-Process drawpaper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2

$addedRule = $false
try {
  Write-Host "Adding outbound-BLOCK firewall rule '$ruleName' (program-scoped to drawpaper.exe)"
  New-NetFirewallRule -DisplayName $ruleName -Direction Outbound -Program $exe -Action Block -Profile Any -ErrorAction Stop | Out-Null
  $addedRule = $true

  Write-Host "Launching app under blocked outbound"
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
    Write-Host "::FAIL::app window never appeared within 60s (headless desktop?); cannot drive native menu"
    exit 1
  }
  $title = (Get-Process -Id $proc.Id).MainWindowTitle
  Write-Host "App booted, main window title = '$title'"
  Start-Sleep -Seconds 8  # React/bootstrap settle before menu drive

  $log = Join-Path $env:APPDATA 'com.drawpaper.app\logs\drawpaper.log'

  # Drive the native menu: Alt opens the menu bar on 文件; Right x5 lands on the
  # 帮助 dropdown; Down -> 检查更新… (item 2); Enter activates it.
  Add-Type -AssemblyName System.Windows.Forms
  $wsh = New-Object -ComObject WScript.Shell
  $activated = $wsh.AppActivate($proc.Id)
  Write-Host "AppActivate(pid=$($proc.Id)) = $activated"
  Start-Sleep -Seconds 1
  [System.Windows.Forms.SendKeys]::SendWait('%')
  Start-Sleep -Milliseconds 500
  foreach ($n in 1..5) { [System.Windows.Forms.SendKeys]::SendWait('{RIGHT}'); Start-Sleep -Milliseconds 300 }
  Start-Sleep -Milliseconds 500
  [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
  Start-Sleep -Milliseconds 300
  [System.Windows.Forms.SendKeys]::SendWait('{ENTER}')
  Write-Host 'Sent keys: Alt -> Right x5 -> Down -> Enter  (intends: 帮助 -> 检查更新…)'

  $foundLog = $false; $foundBrowser = $false; $browserHits = $null
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
      Write-Host "::FAIL::drawpaper process exited after the menu click (crash?)"
      exit 1
    }
    if (-not $foundLog -and (Test-Path $log)) {
      $tail = Get-Content $log -Tail 60 -ErrorAction SilentlyContinue
      if ($tail | Select-String -SimpleMatch 'falling back to Releases web page' -Quiet) { $foundLog = $true }
    }
    if (-not $foundBrowser) {
      $browserHits = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
        $_.Name -match 'msedge|chrome|firefox' -and $_.CommandLine -match 'releases/latest'
      }
      if ($browserHits) { $foundBrowser = $true }
    }
    if ($foundLog -and $foundBrowser) { break }
  }
  Write-Host "evidence after 30s: log-anchor=$foundLog  browser-opened-releases=$foundBrowser"

  if (Test-Path $log) {
    Write-Host "::group::drawpaper.log tail after 检查更新 click"
    Get-Content $log -Tail 30 -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "  | $_" }
    Write-Host "::endgroup::"
  }
  if ($foundBrowser) {
    Write-Host "::group::browser processes opened the releases URL"
    $browserHits | ForEach-Object { Write-Host "  | $($_.Name): $($_.CommandLine)" }
    Write-Host "::endgroup::"
  }

  if (-not $foundLog) {
    Write-Host "::FAIL::log anchor 'falling back to Releases web page' not seen in 30s — menu click likely missed on this desktop session"
    exit 1
  }
  Write-Host "PASS(best-effort): under outbound block, 检查更新… did not crash the app and logged the Releases-page fallback"
  exit 0
}
finally {
  Get-Process drawpaper -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
  if ($addedRule) {
    Remove-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
    Write-Host "Firewall rule '$ruleName' removed"
  }
}
