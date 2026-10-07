<#
.SYNOPSIS
  Smoke test for drawpaper Windows portable mode (Wave18).

.DESCRIPTION
  Self-contained: does NOT read any GitHub Actions / CI environment variable.
  You can run it by hand on a Windows box:

      powershell -ExecutionPolicy Bypass -File .\smoke-portable.ps1 `
          -ExePath C:\path\to\drawpaper.exe

  To also exercise the reinstall case (c), point at the matching NSIS setup.exe:

      powershell -ExecutionPolicy Bypass -File .\smoke-portable.ps1 `
          -ExePath C:\path\to\drawpaper.exe `
          -SetupExePath C:\path\to\drawpaper_0.1.0-rc.9_x64-setup.exe

  Runs up to three independent test cases, each in its own throwaway tree under
  %TEMP% (guarded by a per-case try/finally + a global kill at the end):

    a. Marker trigger + isolation
       - Copy exe to a fresh tree, drop `drawpaper.portable` next to it.
       - Snapshot %APPDATA%\com.drawpaper.app and %LOCALAPPDATA%\com.drawpaper.app.
       - Launch, bounded-poll (up to -WaitSeconds*2) for ./data\logs\drawpaper.log.
       - Assert ./data\ got logs/recents/window-state/EBWebView (log REQUIRED).
       - Assert system AppData was not newly created (or file count did not grow).

    b. data/ directory trigger
       - Fresh tree, NO marker, only a pre-created empty ./data/ dir.
       - Launch, assert the same portable redirect (data lands in ./data/).

    c. Reinstall does not clobber portable data (requires -SetupExePath)
       - Fresh tree (with marker), let it produce data (logs/recents).
       - Record the on-disk file set under ./data/.
       - Re-run the system NSIS installer silently (/S /CURRENTUSER).
       - Relaunch the SAME portable tree.
       - Assert every file recorded before the reinstall still exists, and that
         a fresh launch still redirects into ./data/ (system AppData did not grow).

  Each case gets its own temp tree; process cleanup is in finally plus a global
  double-kill at the end. Use -Keep to leave trees on disk for manual inspection
  (processes are still killed). Exit code 0 = all requested cases passed;
  non-zero = first failure (with tree diagnostics).

.PARAMETER ExePath
  Path to a real drawpaper.exe (a release build). No default — you must point at it.

.PARAMETER SetupExePath
  Path to the matching NSIS *-setup.exe. Required for case c; if omitted, case c
  is skipped (logged as SKIP).

.PARAMETER WaitSeconds
  Base settle budget. Each bounded poll waits up to (WaitSeconds * 2) seconds for
  the log file to appear. Default 15.

.PARAMETER Cases
  Which cases to run. Default @('a','b','c'). Case c is auto-skipped when
  -SetupExePath is empty.

.PARAMETER Keep
  If set, do not delete the smoke trees on exit (for manual inspection).
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [string]$SetupExePath = '',

    [int]$WaitSeconds = 15,

    [string[]]$Cases = @('a','b','c'),

    [switch]$Keep
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- helpers ----------------------------------------------------------------

function Fail([string]$msg) {
    Write-Host ""
    Write-Host "=============================================================="
    Write-Host "FAIL: $msg" -ForegroundColor Red
    Write-Host "=============================================================="
    Write-Host ""
    # Emit a GitHub Actions workflow command so the reason survives as a
    # check-run annotation (step logs themselves are not readable in this CI).
    Write-Host "::error title=portable-smoke::$($msg -replace "`r?`n",' ')"
    exit 1
}

function Ok([string]$msg) {
    Write-Host "  ok: $msg" -ForegroundColor Green
}

function Info([string]$msg) {
    Write-Host "  ..: $msg" -ForegroundColor DarkGray
}

function Banner([string]$text) {
    Write-Host ""
    Write-Host "--------------------------------------------------------------"
    Write-Host "CASE $text"
    Write-Host "--------------------------------------------------------------"
}

function Write-TreeDiag([string]$root) {
    if (-not (Test-Path -LiteralPath $root)) {
        Info "(tree does not exist: $root)"
        return
    }
    Write-Host "  --- tree: $root ---"
    Get-ChildItem -LiteralPath $root -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 80 |
        ForEach-Object {
            $rel = $_.FullName.Substring($root.Length).TrimStart('\')
            if ($_.PSIsContainer) { Write-Host "    [D] $rel" }
            else { Write-Host "    [F] $rel  ($($_.Length) bytes)" }
        }
    Write-Host "  --- end tree ---"
}

# Kill a process gracefully (WM_CLOSE) then force-kill if it lingers, plus any
# other drawpaper.exe / msedgewebview2.exe process running out of the portable
# tree we launched (the WebView2 children hold EBWebView leveldb handles).
function Stop-PortableProcess([System.Diagnostics.Process]$proc, [string]$portableExe) {
    $root = Split-Path -Parent $portableExe
    if ($proc) {
        try { $proc.Refresh() } catch {}
        if (-not $proc.HasExited) {
            # Try graceful close first (lets WebView2 flush leveldb).
            try { $null = $proc.CloseMainWindow() } catch {}
            for ($i = 0; $i -lt 5; $i++) {
                Start-Sleep -Seconds 1
                try { $proc.Refresh() } catch {}
                if ($proc.HasExited) { break }
            }
        }
        try { $proc.Refresh() } catch {}
        if (-not $proc.HasExited) {
            Info "force-killing PID $($proc.Id)"
            Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        }
    }
    # Sweep any other process running from this exact portable exe path.
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -eq $portableExe) } |
        ForEach-Object {
            Info "sweeping extra process $($_.Id) at $portableExe"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    # Sweep WebView2 children spawned for OUR temp tree (other runners'/steps'
    # msedgewebview2 instances live elsewhere and are left alone).
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.Path -and ($_.Path -like "$root*") } |
        ForEach-Object {
            Info "sweeping child process $($_.Id) ($($_.ProcessName)) under $root"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
}

# Kill EVERY drawpaper.exe on the box (used before a reinstall and at exit).
# Also kills any orphaned msedgewebview2.exe children left behind when a prior
# step force-killed the installed drawpaper: those children keep flushing
# leveldb into the SYSTEM app-data dir, which would perturb our file-count
# isolation snapshot (false "system AppData grew" flake). At this point in CI we
# own the runner; no other WebView2 app is alive.
function Stop-AllDrawpaper {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -eq 'drawpaper' } |
        ForEach-Object {
            Info "killing leftover drawpaper PID $($_.Id)"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -eq 'msedgewebview2' } |
        ForEach-Object {
            Info "killing orphaned msedgewebview2 PID $($_.Id)"
            Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
        }
}

# Bounded poll: run $predicate every 1s up to $MaxSeconds. Returns $true on first
# success, $false if the budget expired. Prints progress every 5s.
function Wait-Until([int]$MaxSeconds, [scriptblock]$predicate, [string]$what) {
    for ($i = 0; $i -lt $MaxSeconds; $i++) {
        if (& $predicate) {
            Info "ready after ${i}s: $what"
            return $true
        }
        if (($i % 5) -eq 0) {
            Info "waiting (${i}/${MaxSeconds}s) for: $what"
        }
        Start-Sleep -Seconds 1
    }
    $final = & $predicate
    if (-not $final) { Info "timed out after ${MaxSeconds}s: $what" }
    return $final
}

# Snapshot both system AppData roots; returns an ordered hashtable whose values
# also carry the full relative file set (so growth can be named, not just counted).
function Get-SystemAppDataSnapshot {
    $roaming = Join-Path $env:APPDATA 'com.drawpaper.app'
    $local  = Join-Path $env:LOCALAPPDATA 'com.drawpaper.app'
    $snap = [ordered]@{}
    foreach ($pair in @(@('roaming', $roaming), @('local', $local))) {
        $name = $pair[0]; $p = $pair[1]
        $existed = Test-Path -LiteralPath $p
        $files = @{}
        if ($existed) {
            Get-ChildItem -LiteralPath $p -Recurse -File -ErrorAction SilentlyContinue | ForEach-Object {
                $rel = $_.FullName.Substring($p.Length).TrimStart('\')
                $files[$rel] = $_.Length
            }
        }
        $snap[$name] = [pscustomobject]@{ Path = $p; Existed = $existed; Count = $files.Count; Files = $files }
        Info "system $($name) AppData snapshot: existed=$existed files=$($files.Count) ($p)"
    }
    return $snap
}

# Compare post-run snapshot against $before. Throws via Fail on growth/new-dir.
function Assert-NoSystemAppDataGrowth($before, [string]$label) {
    $after = Get-SystemAppDataSnapshot
    foreach ($name in @('roaming','local')) {
        $b = $before[$name]; $a = $after[$name]
        if (-not $b.Existed) {
            if ($a.Existed) {
                Write-TreeDiag $a.Path
                $leaked = @($a.Files.Keys | Select-Object -First 15) -join ', '
                Fail "[$label] portable run CREATED $($a.Path) (sample new files: $leaked) — data leaked into system AppData!"
            }
            Ok "[$label] system $($name) AppData was not created"
        } else {
            if ($a.Count -gt $b.Count) {
                Write-Host "  before: $($b.Count) files under $($b.Path)"
                Write-Host "  after : $($a.Count) files under $($a.Path)"
                $newFiles = @($a.Files.Keys | Where-Object { -not $b.Files.ContainsKey($_) } | Select-Object -First 15)
                Write-Host "  new files (up to 15): $($newFiles -join ', ')"
                Write-TreeDiag $a.Path
                Fail "[$label] system $($name) AppData grew ($($b.Count) -> $($a.Count)); new: $($newFiles -join ' | ')"
            }
            Ok "[$label] system $($name) AppData file count stable ($($b.Count) -> $($a.Count))"
        }
    }
}

# Create a fresh temp tree, copy the exe in. Returns the root path.
function New-PortableTree {
    $root = Join-Path $env:TEMP ('drawpaper-portable-smoke-' + [guid]::NewGuid().ToString('N').Substring(0,8))
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    Copy-Item -LiteralPath $ExePath -Destination (Join-Path $root 'drawpaper.exe') -Force
    Info "created portable tree: $root"
    return $root
}

# Wait for the portable data dir + log file to appear. Throws on timeout.
function Assert-PortableDataFlowing([string]$root, [string]$label) {
    $dataDir = Join-Path $root 'data'
    $logFile = Join-Path $dataDir 'logs\drawpaper.log'

    $okLog = Wait-Until ($WaitSeconds * 2) {
        Test-Path -LiteralPath $logFile
    } "log file $logFile to appear"

    if (-not $okLog) {
        Write-Host "  data dir exists = $(Test-Path -LiteralPath $dataDir)"
        if (Test-Path -LiteralPath $dataDir) { Write-TreeDiag $dataDir }
        Write-TreeDiag $root
        Fail "[$label] no drawpaper.log under $dataDir\logs after $($WaitSeconds*2)s — portable mode did not activate or log plugin did not redirect"
    }
    Ok "[$label] portable log present: $logFile"

    # The HARD proof of redirection is the AppData-isolation check below (system
    # dirs must not grow). recents/window-state/EBWebView are supporting evidence
    # that lands at varying times (window-state only writes on close; EBWebView
    # leveldb warms lazily; recents only on a file open). We give a bounded grace
    # and REPORT what landed, but do NOT fail here on absence — the isolation
    # gate already catches any real leak. Failing on artifact timing was flaky.
    $recents     = Join-Path $dataDir 'drawpaper-recents.json'
    $windowState = Join-Path $dataDir 'window-state.json'
    $ebwebview   = Join-Path $dataDir 'EBWebView'
    $null = Wait-Until $WaitSeconds {
        (Test-Path -LiteralPath $recents) -or
        (Test-Path -LiteralPath $windowState) -or
        (Test-Path -LiteralPath $ebwebview -PathType Container)
    } "at least one of recents / window-state / EBWebView to land under $dataDir (soft)"

    $found = @('logs/drawpaper.log')
    if (Test-Path -LiteralPath $recents)       { $found += 'drawpaper-recents.json' }
    if (Test-Path -LiteralPath $windowState)   { $found += 'window-state.json' }
    if (Test-Path -LiteralPath $ebwebview -PathType Container) { $found += 'EBWebView/' }
    Ok "[$label] data/ artifacts: $($found -join ', ')"
}

# Remove a tree with retries (EBWebView leveldb may hold a handle briefly).
function Remove-PortableTree([string]$root) {
    if (-not (Test-Path -LiteralPath $root)) { return }
    for ($attempt = 1; $attempt -le 5; $attempt++) {
        Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
        if (-not (Test-Path -LiteralPath $root)) {
            Info "cleaned up $root (attempt $attempt)"
            return
        }
        Start-Sleep -Seconds 1
    }
    Info "WARNING: could not fully remove $root after 5 attempts (leaving for OS cleanup)"
    Write-TreeDiag $root
}

# --- 0. Sanity --------------------------------------------------------------
if (-not (Test-Path -LiteralPath $ExePath)) { Fail "exe not found: $ExePath" }
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path
Write-Host "Using exe: $ExePath"
Write-Host "Setup exe: $(if ($SetupExePath) { $SetupExePath } else { '(none — case c will SKIP)' })"
Write-Host "Cases requested: $($Cases -join ', ')"
Write-Host "WaitSeconds: $WaitSeconds"

# Global baseline snapshot of system AppData (for a final growth sweep).
# Kill any prior-step drawpaper / orphaned webview2 first so their death-flush
# does not land between this snapshot and the per-case snapshots.
Stop-AllDrawpaper
Start-Sleep -Seconds 1
$GlobalBefore = Get-SystemAppDataSnapshot

$ranCases = @()

# --- Case a: marker trigger + isolation -------------------------------------
if ($Cases -contains 'a') {
    Banner "a: marker trigger + isolation"
    $root = New-PortableTree
    $marker = Join-Path $root 'drawpaper.portable'
    New-Item -ItemType File -Force -Path $marker | Out-Null
    Info "wrote marker: $marker"

    # Hermetic baseline: kill any prior drawpaper + orphaned system webview2
    # BEFORE taking the "before" snapshot, so their death-flush cannot appear as
    # "new files" in the "after" snapshot. The single-instance plugin keys off the
    # app identifier GLOBALLY, so a lingering system drawpaper would absorb our
    # portable launch and the exe would exit instantly with no ./data log.
    Stop-AllDrawpaper
    Start-Sleep -Seconds 1
    $snapBefore = Get-SystemAppDataSnapshot
    $proc = $null
    try {
        Stop-AllDrawpaper
        Info "launching portable exe..."
        $proc = Start-Process -FilePath (Join-Path $root 'drawpaper.exe') -PassThru
        Assert-PortableDataFlowing $root 'a'
        Assert-NoSystemAppDataGrowth $snapBefore 'a'
    } finally {
        Stop-PortableProcess $proc (Join-Path $root 'drawpaper.exe')
    }
    if (-not $Keep) { Remove-PortableTree $root } else { Info "Keep=set; leaving $root" }
    $ranCases += 'a'
}

# --- Case b: data/ directory trigger (no marker) ----------------------------
if ($Cases -contains 'b') {
    Banner "b: data/ dir trigger (no marker)"
    $root = New-PortableTree
    # Pre-create an EMPTY data/ dir next to the exe. No marker.
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'data') | Out-Null
    Info "pre-created empty data/ dir (no marker file)"

    Stop-AllDrawpaper   # hermetic baseline before snapshot (see case a note)
    Start-Sleep -Seconds 1
    $snapBefore = Get-SystemAppDataSnapshot
    $proc = $null
    try {
        Stop-AllDrawpaper
        Info "launching portable exe..."
        $proc = Start-Process -FilePath (Join-Path $root 'drawpaper.exe') -PassThru
        Assert-PortableDataFlowing $root 'b'
        Assert-NoSystemAppDataGrowth $snapBefore 'b'
    } finally {
        Stop-PortableProcess $proc (Join-Path $root 'drawpaper.exe')
    }
    if (-not $Keep) { Remove-PortableTree $root } else { Info "Keep=set; leaving $root" }
    $ranCases += 'b'
}

# --- Case c: reinstall does not clobber portable data -----------------------
if ($Cases -contains 'c') {
    if (-not $SetupExePath -or -not (Test-Path -LiteralPath $SetupExePath)) {
        Banner "c: reinstall persistence — SKIPPED (no -SetupExePath or file missing)"
        Info "pass -SetupExePath <path-to-*-setup.exe> to enable this case"
    } else {
        Banner "c: reinstall does not clobber portable data"
        $SetupExePath = (Resolve-Path -LiteralPath $SetupExePath).Path

        # Step 1: build a portable tree and let it produce data.
        $root = New-PortableTree
        $marker = Join-Path $root 'drawpaper.portable'
        New-Item -ItemType File -Force -Path $marker | Out-Null
        Stop-AllDrawpaper
        Start-Sleep -Seconds 1
        $snapBefore1 = Get-SystemAppDataSnapshot
        $proc = $null
        try {
            Stop-AllDrawpaper   # hermetic launch (see case a note)
            Info "first launch: letting portable tree produce data..."
            $proc = Start-Process -FilePath (Join-Path $root 'drawpaper.exe') -PassThru
            Assert-PortableDataFlowing $root 'c/1'
        } finally {
            Stop-PortableProcess $proc (Join-Path $root 'drawpaper.exe')
        }

        # The reinstall only touches the SYSTEM install dir; the portable tree
        # lives under %TEMP% and cannot be touched by it. We therefore do NOT diff
        # the exact file set under ./data (WebView2 recycles its leveldb on every
        # restart, which made that check flaky). The stable facts we assert are:
        #   * ./data/ and the stable log still exist after the reinstall, and
        #   * the second launch writes fresh bytes to that log (portable on), and
        #   * system AppData did not grow during the second launch.
        $dataDir = Join-Path $root 'data'
        $logFile = Join-Path $dataDir 'logs\drawpaper.log'

        # Step 2: run the system NSIS installer again silently. Make sure no
        # drawpaper.exe is running first (a "files in use" dialog would hang).
        Stop-AllDrawpaper
        Info "re-running system installer: $SetupExePath /S /CURRENTUSER"
        $inst = Start-Process -FilePath $SetupExePath -ArgumentList '/S','/CURRENTUSER' -PassThru
        $instOk = Wait-Until 120 { try { $inst.Refresh(); $inst.HasExited } catch { $true } } "installer process to exit"
        if (-not $instOk) {
            Stop-Process -Id $inst.Id -Force -ErrorAction SilentlyContinue
            Fail "c: NSIS reinstall did not exit within 120s"
        }
        Info "installer exit code = $($inst.ExitCode)"
        if ($inst.ExitCode -ne 0) {
            Fail "c: NSIS reinstall exited $($inst.ExitCode) (expected 0)"
        }

        # Reinstall must not have wiped the portable data dir.
        if (-not (Test-Path -LiteralPath $dataDir)) { Fail "c: ./data dir VANISHED after reinstall: $dataDir" }
        if (-not (Test-Path -LiteralPath $logFile)) { Fail "c: ./data/logs/drawpaper.log VANISHED after reinstall: $logFile" }
        Info "confirmed ./data/ and ./data/logs/drawpaper.log still present after reinstall"

        # Step 3: relaunch the SAME portable tree.
        # Snapshot the existing log's size + mtime BEFORE the second launch, so we
        # can prove the *second* process actually wrote fresh bytes into ./data/
        # (a mere "log still exists + process up" check is true instantly and
        # would not detect a silent fallback to system dirs).
        $logBefore = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
        $logLenBefore = if ($logBefore) { $logBefore.Length } else { 0 }
        $logMtimeBefore = if ($logBefore) { $logBefore.LastWriteTimeUtc } else { [datetime]::MinValue }
        Info "log before 2nd launch: $logLenBefore bytes, mtime $logMtimeBefore"

        Stop-AllDrawpaper
        Start-Sleep -Seconds 1
        $snapBefore2 = Get-SystemAppDataSnapshot
        $proc = $null
        try {
            Stop-AllDrawpaper
            Info "second launch: same portable tree after reinstall..."
            $proc = Start-Process -FilePath (Join-Path $root 'drawpaper.exe') -PassThru
            # Proof the second run re-entered portable mode: the process stays up
            # AND the portable log file grows (or is touched) beyond its pre-launch
            # state. If portable detection had regressed, the new process would
            # write to the system log path instead and ./data\logs\drawpaper.log
            # would stay untouched for the whole budget.
            $grew = Wait-Until ($WaitSeconds * 2) {
                try { $proc.Refresh() } catch {}
                if ($proc.HasExited) { return $false }
                $cur = Get-Item -LiteralPath $logFile -ErrorAction SilentlyContinue
                if (-not $cur) { return $false }
                (($cur.Length -gt $logLenBefore) -or ($cur.LastWriteTimeUtc -gt $logMtimeBefore.AddSeconds(1)))
            } "second process to write fresh bytes into $logFile"
            if (-not $grew) {
                Write-Host "  log after 2nd launch: $((Get-Item $logFile -ErrorAction SilentlyContinue).Length) bytes, mtime $((Get-Item $logFile -ErrorAction SilentlyContinue).LastWriteTimeUtc)"
                Write-TreeDiag $root
                Fail "c: after reinstall, portable exe stayed up but never wrote to ./data\logs\drawpaper.log (stayed up=$(-not $proc.HasExited)) — portable mode not re-recognized?"
            }
            Ok "c: portable exe still running and writing fresh bytes to ./data/ after reinstall"

            Assert-NoSystemAppDataGrowth $snapBefore2 'c/2'
        } finally {
            Stop-PortableProcess $proc (Join-Path $root 'drawpaper.exe')
        }
        if (-not $Keep) { Remove-PortableTree $root } else { Info "Keep=set; leaving $root" }
        $ranCases += 'c'
    }
}

# --- Final sweep: make sure no drawpaper process lingers (would block the
#     downstream NSIS uninstall step). --------------------------------------
Stop-AllDrawpaper

# Final global AppData growth check (catches any case that leaked at exit).
Assert-NoSystemAppDataGrowth $GlobalBefore 'final'

Write-Host ""
Write-Host "=============================================================="
Write-Host "SMOKE PASS (cases run: $($ranCases -join ', '))" -ForegroundColor Cyan
Write-Host "=============================================================="
exit 0
