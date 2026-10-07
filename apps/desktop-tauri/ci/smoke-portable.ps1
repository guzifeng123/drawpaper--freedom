<#
.SYNOPSIS
  Manual smoke test for drawpaper Windows portable mode (Wave16-I).

.DESCRIPTION
  Self-contained: does NOT read any GitHub Actions / CI environment variable.
  You can run it by hand on a Windows box:

      powershell -ExecutionPolicy Bypass -File .\smoke-portable.ps1 -ExePath C:\path\to\drawpaper.exe

  What it does:
    1. Builds a throwaway portable tree under $env:TEMP\drawpaper-portable-smoke\
    2. Copies drawpaper.exe there and drops the `drawpaper.portable` marker next to it
    3. Snapshots whether %APPDATA%\com.drawpaper.app already exists
    4. Launches the exe, waits for it to write data
    5. Asserts ./data\ got populated (logs / recents / window-state)
    6. Asserts the system AppData dir was NOT newly created by this portable run
    7. Kills the spawned process and cleans up (prints the tree first so you can inspect)

  Exit code 0 = portable mode behaved correctly; non-zero = assertion failed.

.PARAMETER ExePath
  Path to a real drawpaper.exe (a release build). No default — you must point at it.

.PARAMETER WaitSeconds
  How long to let the app run before asserting. Default 10.

.PARAMETER Keep
  If set, do not delete the smoke tree on exit (for manual inspection).
#>

param(
    [Parameter(Mandatory = $true)]
    [string]$ExePath,

    [int]$WaitSeconds = 10,

    [switch]$Keep
)

$ErrorActionPreference = 'Stop'

function Fail([string]$msg) {
    Write-Host "FAIL: $msg" -ForegroundColor Red
    exit 1
}

function Ok([string]$msg) {
    Write-Host "ok:   $msg" -ForegroundColor Green
}

# --- 0. Sanity: the exe actually exists -------------------------------------
if (-not (Test-Path -LiteralPath $ExePath)) {
    Fail "exe not found: $ExePath"
}
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path
Write-Host "Using exe: $ExePath"

# --- 1. Build the portable tree --------------------------------------------
$Root = Join-Path $env:TEMP ('drawpaper-portable-smoke-' + [guid]::NewGuid().ToString('N').Substring(0,8))
New-Item -ItemType Directory -Force -Path $Root | Out-Null
$PortableExe = Join-Path $Root 'drawpaper.exe'
Copy-Item -LiteralPath $ExePath -Destination $PortableExe -Force

# Drop the marker file (empty is fine).
$Marker = Join-Path $Root 'drawpaper.portable'
New-Item -ItemType File -Force -Path $Marker | Out-Null
Ok "created portable tree at $Root"
Ok "wrote marker $Marker"

# --- 2. Snapshot system AppData BEFORE the run ------------------------------
$SystemAppData = Join-Path $env:APPDATA 'com.drawpaper.app'
$SystemExistedBefore = Test-Path -LiteralPath $SystemAppData
if ($SystemExistedBefore) {
    Write-Host "note: $SystemAppData already exists on this machine (install-mode data); will compare file counts instead of existence."
    $BeforeCount = (Get-ChildItem -LiteralPath $SystemAppData -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
} else {
    $BeforeCount = 0
}

# --- 3. Launch the portable exe --------------------------------------------
Write-Host "launching $PortableExe (waiting ${WaitSeconds}s)..."
$proc = Start-Process -FilePath $PortableExe -PassThru
try {
    Start-Sleep -Seconds $WaitSeconds

    # --- 4. Assert ./data got populated ------------------------------------
    $DataDir = Join-Path $Root 'data'
    if (-not (Test-Path -LiteralPath $DataDir)) {
        Fail "expected portable data dir $DataDir to exist, but it does not (portable mode did not activate?)"
    }
    Ok "portable data dir exists: $DataDir"

    $LogDir = Join-Path $DataDir 'logs'
    $LogFile = Join-Path $LogDir 'drawpaper.log'
    $Recents = Join-Path $DataDir 'drawpaper-recents.json'
    $WindowState = Join-Path $DataDir 'window-state.json'
    $EBWebView = Join-Path $DataDir 'EBWebView'

    $found = @()
    if (Test-Path -LiteralPath $LogFile)    { $found += 'logs/drawpaper.log' }
    if (Test-Path -LiteralPath $Recents)    { $found += 'drawpaper-recents.json' }
    if (Test-Path -LiteralPath $WindowState) { $found += 'window-state.json' }
    if (Test-Path -LiteralPath $EBWebView -PathType Container) { $found += 'EBWebView/' }

    # At least the log file MUST exist; the others are nice-to-have on first run.
    if (-not (Test-Path -LiteralPath $LogFile)) {
        Fail "no drawpaper.log under $LogDir — log plugin did not redirect into ./data"
    }
    Ok ("data/ populated with: " + ($found -join ', '))

    # --- 5. Assert system AppData was not newly written --------------------
    if (-not $SystemExistedBefore) {
        if (Test-Path -LiteralPath $SystemAppData) {
            Fail "portable run CREATED $SystemAppData — data leaked into system AppData!"
        }
        Ok "system AppData dir was NOT created (stays isolated from installed mode)"
    } else {
        Start-Sleep -Seconds 1
        $AfterCount = (Get-ChildItem -LiteralPath $SystemAppData -Recurse -File -ErrorAction SilentlyContinue | Measure-Object).Count
        if ($AfterCount -gt $BeforeCount) {
            Fail "system AppData grew during portable run ($BeforeCount -> $AfterCount files) — data leaked!"
        }
        Ok "system AppData file count stable ($BeforeCount -> $AfterCount)"
    }

    Write-Host ""
    Write-Host "Portable tree for inspection:"
    Get-ChildItem -LiteralPath $DataDir -Recurse -ErrorAction SilentlyContinue |
        Select-Object -First 40 | ForEach-Object { Write-Host ("  " + $_.FullName.Substring($Root.Length)) }
}
finally {
    # --- 6. Clean up the process -------------------------------------------
    if ($proc -and -not $proc.HasExited) {
        # Kill the whole tree (the exe may have spawned WebView2 children).
        Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
        Get-Process | Where-Object { $_.Path -eq $PortableExe } |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Ok "stopped drawpaper process"
    }
}

if (-not $Keep) {
    Start-Sleep -Seconds 1
    Remove-Item -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue
    Ok "cleaned up $Root"
} else {
    Write-Host "Keep=set; leaving tree at $Root"
}

Write-Host ""
Write-Host "SMOKE PASS" -ForegroundColor Cyan
exit 0
