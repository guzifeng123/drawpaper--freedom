<#
.SYNOPSIS
  Cross-arch headless CLI smoke for an installed drawpaper.exe (Wave23 E).

.DESCRIPTION
  Self-contained: does NOT depend on GitHub Actions env (but emits ::error
  annotations so failures surface on the anonymous run page). Runnable by hand:

      pwsh -NoProfile -ExecutionPolicy Bypass -File .\smoke-cli.ps1 `
          -ExePath "C:\Users\runner\AppData\Local\Programs\drawpaper\drawpaper.exe" `
          -Arch x64

  or by install dir (exe name defaults to drawpaper.exe):

      pwsh -NoProfile -ExecutionPolicy Bypass -File .\smoke-cli.ps1 `
          -InstallDir "C:\Users\runner\AppData\Local\Programs\drawpaper" -Arch arm64

  Encapsulates the headless-CLI assertion suite that used to live inline in the
  x64 build job, so the SAME suite now runs on the native arm64 runner too.

  Assertions (non-zero exit = red; no try/catch swallows a failure):

    1. VERSION  The installed exe reports the source-of-truth version:
         - exe file ProductVersion numeric-tokens == tauri.conf version
           (Windows may rewrite 0.1.0-rc.14 -> 0.1.0.14; compare digit runs).
         - the headless run produces a diag system.json whose `version` field
           (built from CARGO_PKG_VERSION) numeric-tokens == tauri.conf version.
       drawpaper ships no `--version` flag (it is a GUI app with hidden headless
       hooks); the diag package's embedded system.json.version IS the equivalent
       "version report" of the running binary.

    2. USAGE   The headless dispatch actually happened: the captured stderr of
       the CLI call contains the handler marker `[diag-export]` (its usage /
       identification line). drawpaper ships no `--help`; this marker is the
       equivalent usage keyword. Exit code 0 is asserted separately below.

    3. NO-WINDOW LIFECYCLE  The headless CLI call must exit on its own inside a
       bounded budget and leave NO drawpaper process behind. We launch via
       `cmd /c ... > log 2>&1` (outer-quote wrapping, proven in Wave18) and
       poll for up to -WaitSeconds; on expiry we kill in `finally` and still go
       red (Wave18 P2 rigor, NOT loosened). After the run we sweep any residual
       drawpaper and fail if one survived.

    4. --diag-export PRIVACY CANARY  (same source / same strength as the old
       x64 inline step):
         - plant SECRET-canary.kbnote + assets/img.png whose BYTES are a unique
           secret string under %APPDATA%\com.drawpaper.app;
         - run `--diag-export <zip>`; assert exit 0 and a real ZIP (PK header);
         - expand and assert: no *.kbnote entry, no assets/ entry, the canary
           secret string has ZERO hits across every extracted file;
         - system.json present with non-empty version / arch and a
           webview2_runtime_version field;
         - files-manifest.json entries each have EXACTLY name/size/mtime;
         - coldstart.json present (Wave25): headless CLI has no webview, so it
           must be the controlled {"status":"unavailable","reason":...} shape;
           if a real report ever appears, recursively assert only
           number/bool/null leaves + short identifier keys (no body strings).

  Exit code 0 = all assertions passed; non-zero = first failure (with
  diagnostics dumped and a ::error annotation).

.PARAMETER ExePath
  Direct path to drawpaper.exe (ParameterSet ByPath).

.PARAMETER InstallDir
  Install directory; the exe is resolved inside it (ParameterSet ByDir).

.PARAMETER ExeName
  Exe file name inside -InstallDir. Default 'drawpaper.exe'.

.PARAMETER Arch
  Free-form architecture label used in logs / annotations, e.g. 'x64' or
  'arm64'.

.PARAMETER WaitSeconds
  Bounded budget (seconds) for the headless CLI call to exit on its own.
  Default 60.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true, ParameterSetName = 'ByPath')]
    [string]$ExePath,

    [Parameter(Mandatory = $true, ParameterSetName = 'ByDir')]
    [string]$InstallDir,

    [string]$ExeName = 'drawpaper.exe',

    [Parameter(Mandatory = $true)]
    [string]$Arch,

    [int]$WaitSeconds = 60
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# --- helpers ----------------------------------------------------------------

function Fail([string]$msg) {
    Write-Host ""
    Write-Host "=============================================================="
    Write-Host "FAIL [$Arch]: $msg" -ForegroundColor Red
    Write-Host "=============================================================="
    # Surface as a workflow annotation (step logs are sign-in gated).
    Write-Host "::error title=smoke-cli[$Arch]::$($msg -replace "`r?`n",' ')"
    exit 1
}

function Ok([string]$msg) { Write-Host "  ok: $msg" -ForegroundColor Green }
function Info([string]$msg) { Write-Host "  ..: $msg" -ForegroundColor DarkGray }
function Banner([string]$text) {
    Write-Host ""
    Write-Host "--------------------------------------------------------------"
    Write-Host "SMOKE-CLI[$Arch] $text"
    Write-Host "--------------------------------------------------------------"
}

# Windows ProductVersion may rewrite a prerelease tag (0.1.0-rc.14 ->
# 0.1.0.14). Compare the NUMERIC token runs, padding the shorter side with
# trailing zeros. Returns the padded token list.
function Get-NumTokens([string]$v) {
    if (-not $v) { return @() }
    return @([regex]::Matches($v, '\d+') | ForEach-Object { [int]$_.Value })
}

function Assert-VersionTokens([string]$expected, [string]$got, [string]$what) {
    $exp = Get-NumTokens $expected
    $gotT = Get-NumTokens $got
    Write-Host ("  {0}: expected='{1}' got='{2}'" -f $what, $expected, $got)
    $max = [Math]::Max($exp.Count, $gotT.Count)
    while ($exp.Count -lt $max)   { $exp += 0 }
    while ($gotT.Count -lt $max)  { $gotT += 0 }
    if (@(Compare-Object $exp $gotT -SyncWindow 0).Count -ne 0) {
        Fail "version mismatch on $what. tauri.conf='$expected' vs reported='$got'"
    }
    Ok "version tokens match ($what)"
}

# Kill every drawpaper.exe on the box (headless call must leave none behind;
# also unblocks the downstream uninstall). Orphaned WebView2 children are swept
# too. Best-effort: never throws.
function Stop-AllDrawpaper {
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -eq 'drawpaper' } |
        ForEach-Object { Info "killing residual drawpaper PID $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
    Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -eq 'msedgewebview2' } |
        ForEach-Object { Info "killing residual msedgewebview2 PID $($_.Id)"; Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue }
}

# --- 0. Resolve the exe ------------------------------------------------------
Banner 'resolve exe'
if ($PSCmdlet.ParameterSetName -eq 'ByDir') {
    if (-not (Test-Path -LiteralPath $InstallDir)) { Fail "install dir not found: $InstallDir" }
    $ExePath = Join-Path $InstallDir $ExeName
    if (-not (Test-Path -LiteralPath $ExePath)) {
        $found = Get-ChildItem -LiteralPath $InstallDir -Recurse -Filter $ExeName -File -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($found) { $ExePath = $found.FullName }
    }
}
if (-not (Test-Path -LiteralPath $ExePath)) { Fail "exe not found: $ExePath" }
$ExePath = (Resolve-Path -LiteralPath $ExePath).Path
Write-Host "Arch label : $Arch"
Write-Host "ExePath    : $ExePath"
Write-Host "WaitSeconds: $WaitSeconds"

# --- 1. Expected version straight from tauri.conf.json (source of truth) -----
# Resolve relative to THIS script (apps/desktop-tauri/ci/ -> ../src-tauri/) so
# the script is CWD-independent when run by hand.
$tauriConfPath = Join-Path $PSScriptRoot '..\src-tauri\tauri.conf.json'
if (-not (Test-Path -LiteralPath $tauriConfPath)) {
    # Fall back to the CI checkout-root relative path.
    $tauriConfPath = 'apps/desktop-tauri/src-tauri/tauri.conf.json'
}
if (-not (Test-Path -LiteralPath $tauriConfPath)) { Fail "tauri.conf.json not found (tried $tauriConfPath)" }
$tauriConf = Get-Content -Raw -LiteralPath $tauriConfPath | ConvertFrom-Json
$expectedVersion = $tauriConf.version
if (-not $expectedVersion) { Fail "tauri.conf.json has no .version" }
Write-Host "tauri.conf.json version (raw) = '$expectedVersion'"

# --- Assertion 1 (a): exe file ProductVersion numeric tokens match -----------
Banner '1. version — exe file ProductVersion'
$productVersion = (Get-Item -LiteralPath $ExePath).VersionInfo.ProductVersion
Assert-VersionTokens $expectedVersion $productVersion 'exe ProductVersion'

# --- Plant the privacy canary BEFORE the headless call -----------------------
$dataDir = Join-Path $env:APPDATA 'com.drawpaper.app'
New-Item -ItemType Directory -Force -Path (Join-Path $dataDir 'assets') | Out-Null
$canary = "CANARY-7f3a9b2e4d5c-never-leak-body-" + [guid]::NewGuid().ToString('N')
Set-Content -Path (Join-Path $dataDir 'SECRET-canary.kbnote') -Value $canary -NoNewline -Encoding utf8
Set-Content -Path (Join-Path $dataDir 'assets' 'img.png') -Value $canary -NoNewline -Encoding utf8
Write-Host "Planted canary (body length=$($canary.Length)) at $dataDir"

$outZip  = Join-Path $env:TEMP ('dp-cli-diag-' + [guid]::NewGuid().ToString('N') + '.zip')
$outLog  = Join-Path $env:TEMP ('dp-cli-diag-' + [guid]::NewGuid().ToString('N') + '.log')
Remove-Item $outZip -ErrorAction SilentlyContinue
Remove-Item $outLog -ErrorAction SilentlyContinue

# Clean slate: no prior drawpaper may absorb or race the headless call.
Stop-AllDrawpaper
Start-Sleep -Seconds 1

# --- Assertion 3: bounded lifecycle + finally-kill (Wave18 P2 rigor) --------
Banner '2. headless lifecycle — --diag-export must exit on its own'
# GUI-subsystem exe: wrap with cmd /c to capture the Rust eprintln. The
# ArgumentList gets an OUTER quoted pair so cmd strips those and the inner
# quoting survives (proven in the selftest / probe smokes).
$argLine = '/c "' + '"' + $ExePath + '" --diag-export "' + $outZip + '" > "' + $outLog + '" 2>&1"'
Write-Host "Running: cmd.exe $argLine"
$cp = $null
try {
    $cp = Start-Process -FilePath 'cmd.exe' -ArgumentList $argLine -PassThru -WindowStyle Hidden
    for ($w = 0; $w -lt $WaitSeconds; $w++) {
        Start-Sleep -Seconds 1
        try { $cp.Refresh() } catch {}
        if ($cp.HasExited) { break }
    }
    if (-not $cp.HasExited) {
        # Red, NOT loosened: a headless CLI that does not exit within budget has
        # leaked a window / dialog / webview. Kill it in finally and fail.
        Fail "--diag-export did not exit within ${WaitSeconds}s (leaked window/dialog/webview?)"
    }
    $code = $cp.ExitCode
} finally {
    if ($cp) {
        try { $cp.Refresh() } catch {}
        if (-not $cp.HasExited) { Info "finally: force-killing stuck cmd PID $($cp.Id)"; Stop-Process -Id $cp.Id -Force -ErrorAction SilentlyContinue }
    }
    Stop-AllDrawpaper
}

Write-Host "::group::--diag-export captured stdout/stderr"
if (Test-Path -LiteralPath $outLog) { Get-Content -LiteralPath $outLog | ForEach-Object { Write-Host "  | $_" } } else { Write-Host "  (no output file)" }
Write-Host "::endgroup::"
Write-Host "--diag-export exit code = $code"

# Exit code 0 gate.
if ($code -ne 0) { Fail "--diag-export exited $code (expected 0)" }
Ok "--diag-export exited 0"

# --- Assertion 2: usage marker keyword in captured output -------------------
$logText = if (Test-Path -LiteralPath $outLog) { Get-Content -Raw -LiteralPath $outLog } else { '' }
if ($logText -notmatch '\[diag-export\]') {
    Fail "headless output missing the '[diag-export]' usage/handler marker (CLI dispatch did not happen?)"
}
Ok "headless output carries the [diag-export] usage marker"

# --- Assertion 4a: zip produced and is a real ZIP ----------------------------
Banner '3. --diag-export privacy canary'
if (-not (Test-Path -LiteralPath $outZip)) { Fail 'diag zip not produced' }
$zipLen = (Get-Item -LiteralPath $outZip).Length
Write-Host "diag zip = $outZip ($zipLen bytes)"
if ($zipLen -le 4) { Fail "diag zip implausibly small ($zipLen bytes)" }
$fs = [System.IO.File]::OpenRead($outZip)
$buf = New-Object byte[] 8; [void]$fs.Read($buf, 0, 8); $fs.Close()
$hex = ($buf | ForEach-Object { $_.ToString('x2') }) -join ' '
Write-Host "zip header bytes: $hex"
if ($hex -notmatch '^50 4b 03 04') { Fail "diag zip is not a real ZIP (header=$hex)" }
Ok "diag zip produced with PK header"

# Expand. With $ErrorActionPreference='Stop' a corrupt archive throws and the
# script exits non-zero on its own (no try/catch swallowing).
$extract = Join-Path $env:TEMP ('dp-cli-diag-extract-' + [guid]::NewGuid().ToString('N'))
Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue
Expand-Archive -LiteralPath $outZip -DestinationPath $extract -Force
Write-Host "::group::Extracted diag zip entries"
Get-ChildItem -LiteralPath $extract -Recurse -File | ForEach-Object {
    Write-Host ("  - {0}  ({1} bytes)" -f $_.FullName.Substring($extract.Length + 1), $_.Length)
}
Write-Host "::endgroup::"

# 4b: no *.kbnote entry.
$kbnote = Get-ChildItem -LiteralPath $extract -Recurse -File -Filter '*.kbnote' -ErrorAction SilentlyContinue
if ($kbnote) { $kbnote | ForEach-Object { Write-Host "LEAK: $($_.FullName)" }; Fail 'zip contains a *.kbnote entry' }
Ok "no *.kbnote entry in zip"
# 4c: no assets/ entry.
$assets = Get-ChildItem -LiteralPath $extract -Recurse -File | Where-Object { $_.FullName -match '[\\/]assets[\\/]' }
if ($assets) { $assets | ForEach-Object { Write-Host "LEAK: $($_.FullName)" }; Fail 'zip contains an assets/ entry' }
Ok "no assets/ entry in zip"
# 4d: canary body string zero hits across ALL extracted files.
$leak = Get-ChildItem -LiteralPath $extract -Recurse -File | Select-String -SimpleMatch -Pattern $canary -List -ErrorAction SilentlyContinue
if ($leak) { $leak | ForEach-Object { Write-Host "LEAK in $($_.Path): $($_.Line)" }; Fail 'canary body string found inside diagnostic zip!' }
Ok "canary secret string has zero hits across the whole zip"

# 4e: system.json fields (incl. the running binary's version report).
$sysPath = Join-Path $extract 'system.json'
if (-not (Test-Path -LiteralPath $sysPath)) { Fail 'system.json missing from diag zip' }
$sys = Get-Content -Raw -LiteralPath $sysPath | ConvertFrom-Json
Write-Host ("system.json: version={0} os={1} os_version={2} arch={3} webview2={4} collected_at={5}" -f $sys.version, $sys.os, $sys.os_version, $sys.arch, $sys.webview2_runtime_version, $sys.collected_at)
if (-not $sys.version) { Fail 'system.version empty' }
if (-not $sys.arch)    { Fail 'system.arch empty' }
if ($null -eq $sys.webview2_runtime_version) { Fail 'system.webview2_runtime_version missing' }
if ($sys.webview2_runtime_version -eq 'unknown') { Write-Host '::warning title=wv2-detect::webview2_runtime_version came back unknown on this runner' }
Ok "system.json has version/arch/webview2 fields"

# Assertion 1 (b): the running binary's reported version matches tauri.conf.
Assert-VersionTokens $expectedVersion $sys.version 'system.json.version'

# 4f: manifest entries have exactly name/size/mtime.
$manPath = Join-Path $extract 'files-manifest.json'
if (-not (Test-Path -LiteralPath $manPath)) { Fail 'files-manifest.json missing from diag zip' }
$man = Get-Content -Raw -LiteralPath $manPath | ConvertFrom-Json
Write-Host ("files-manifest.json lists {0} file(s)" -f $man.Count)
$bad = @()
foreach ($e in $man) {
    $props = @($e.PSObject.Properties.Name | Sort-Object)
    if (($props -join ',') -ne 'mtime,name,size') { $bad += ($props -join ',') }
}
if ($bad.Count -gt 0) { Fail ("manifest entries with unexpected fields: " + ($bad -join ' | ')) }
$names = $man | ForEach-Object { $_.name }
Write-Host "  manifest still lists canary by name (metadata-only): $($names -contains 'SECRET-canary.kbnote')"
Ok "manifest entries are exactly name/size/mtime"

# 4g: coldstart.json（Wave25）— 诊断包新条目：web 冷启动分段时间线。
# 无头 CLI 无 webview 可应答 → 合法占位 {"status":"unavailable","reason":...}；
# 若哪天真由 GUI 菜单导出（有 webview），则递归断言只含 number/bool/null
# 与短标识符键——禁止任何字符串叶子（正文类长串绝不能进包）。
Banner '3b. coldstart.json — presence + privacy shape'
$csPath = Join-Path $extract 'coldstart.json'
if (-not (Test-Path -LiteralPath $csPath)) { Fail 'coldstart.json missing from diag zip' }
$csRaw = Get-Content -Raw -LiteralPath $csPath
Write-Host ("coldstart.json ({0} bytes): {1}" -f $csRaw.Length, $csRaw.Trim())
if ($csRaw.Length -gt 65536) { Fail ("coldstart.json implausibly large ({0} bytes) — body leak?" -f $csRaw.Length) }
$cs = $csRaw | ConvertFrom-Json

function Test-ColdStartShape([object]$node, [string]$path) {
    if ($null -eq $node) { return }
    if ($node -is [bool] -or $node -is [int] -or $node -is [long] -or $node -is [double] -or $node -is [decimal]) { return }
    if ($node -is [string]) {
        $preview = $node.ToString(); if ($preview.Length -gt 80) { $preview = $preview.Substring(0, 80) + '...' }
        Fail "coldstart.json unexpected string leaf at ${path}: '$preview'"
    }
    if ($node -is [System.Collections.IEnumerable]) {
        foreach ($item in $node) { Test-ColdStartShape $item ($path + '[]') }
        return
    }
    foreach ($p in $node.PSObject.Properties) {
        if ($p.Name -notmatch '^[A-Za-z][A-Za-z0-9-]{0,31}$') {
            Fail "coldstart.json disallowed key at ${path}: '$($p.Name)'"
        }
        Test-ColdStartShape $p.Value ($path + '.' + $p.Name)
    }
}

$csProps = @($cs.PSObject.Properties.Name)
if ($csProps -contains 'status') {
    if ($cs.status -ne 'unavailable') { Fail "coldstart.json.status unexpected: '$($cs.status)'" }
    # 排序后比集合，与 JSON 键序无关（serde_json 默认 BTreeMap 字母序）。
    if (($csProps | Sort-Object) -join ',' -ne 'reason,status') {
        Fail ("coldstart.json unavailable shape must be exactly status+reason, got: " + ($csProps -join ','))
    }
    Ok "coldstart.json present with controlled status='unavailable' (headless CLI has no webview to answer)"
} else {
    Test-ColdStartShape $cs '$'
    Ok "coldstart.json present; recursive shape check passed (numbers/bools/null + short identifier keys only)"
}

# --- Assertion 3b: no drawpaper process survived the headless call ----------
Banner '4. no residual process'
Start-Sleep -Seconds 1
$left = Get-Process -Name 'drawpaper' -ErrorAction SilentlyContinue
if ($left) {
    $left | ForEach-Object { Write-Host "RESIDUAL: drawpaper PID $($_.Id)" }
    Stop-AllDrawpaper
    Fail "headless --diag-export left a drawpaper process running (must exit on its own)"
}
Ok "no drawpaper process survived the headless call"

# --- cleanup ----------------------------------------------------------------
Remove-Item -LiteralPath $outZip -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $outLog -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $extract -Recurse -Force -ErrorAction SilentlyContinue

Write-Host ""
Write-Host "=============================================================="
Write-Host "SMOKE-CLI[$Arch] PASS: version / usage-marker / headless-lifecycle / diag privacy canary" -ForegroundColor Cyan
Write-Host "=============================================================="
exit 0
