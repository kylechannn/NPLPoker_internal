# Builds the NPL Poker OS installer end to end:
#   1. scripts\build.ps1  -- UI build, go test, exe build, and the complete
#      portable bundle in dist\ (portable PHP, backend with vendor\, fresh
#      .env + APP_KEY, pre-migrated database.sqlite, Caddy).
#   2. Mirrors the needed pieces of dist\ into installer\payload\ (the layout
#      NPLPokerOS.iss expects), verifies every critical file, and refuses to
#      ship an un-checkpointed SQLite database.
#   3. Packs winres\icon*.png into installer\app.ico for the setup wizard.
#   4. Compiles with ISCC.exe and prints the output path + SHA256 for
#      transfer verification on the target laptop.
#
# Usage (from the repo, in Windows PowerShell):
#   powershell -ExecutionPolicy Bypass -File installer\build-installer.ps1 -Version 1.0.0
#
# -SkipBuild reuses an existing dist\ when iterating on the installer alone.

[CmdletBinding()]
param(
    [string]$Version = "1.0.0",
    [string]$ReferenceBundle = "C:\Users\kylec\dist\EdgeHost_bundle",
    [switch]$SkipBuild
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$InstallerDir = $PSScriptRoot
$PayloadDir = Join-Path $InstallerDir "payload"
$OutputDir = Join-Path $InstallerDir "output"
$DistDir = Join-Path $RepoRoot "dist"
$IssFile = Join-Path $InstallerDir "NPLPokerOS.iss"

function Invoke-Robocopy {
    param([string]$Source, [string]$Target, [string[]]$ExtraArgs = @())
    robocopy $Source $Target /MIR /NFL /NDL /NJH /NJS @ExtraArgs | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy '$Source' -> '$Target' failed ($LASTEXITCODE)." }
    $global:LASTEXITCODE = 0
}

function Assert-Files {
    param([string]$Root, [string[]]$RelativePaths, [string]$Context)
    $missing = $RelativePaths | Where-Object { -not (Test-Path -LiteralPath (Join-Path $Root $_)) }
    if ($missing) {
        throw "$Context is missing required files:`n  " + ($missing -join "`n  ")
    }
}

# ---- 1. Full product build --------------------------------------------------
if (-not $SkipBuild) {
    & (Join-Path $RepoRoot "scripts\build.ps1") -Version $Version -ReferenceBundle $ReferenceBundle
} elseif (-not (Test-Path -LiteralPath (Join-Path $DistDir "NPLPokerOS.exe"))) {
    throw "-SkipBuild was passed but dist\ has no NPLPokerOS.exe -- run without -SkipBuild first."
}

$CriticalFiles = @(
    "NPLPokerOS.exe",
    "Caddyfile",
    "ConfigureStaffGateway.ps1",
    "redist\caddy\caddy.exe",
    ".tools\php\php.exe",
    ".tools\php\php.ini",
    "app\npl_internal\artisan",
    "app\npl_internal\vendor\autoload.php",
    "app\npl_internal\.env",
    "app\npl_internal\database\database.sqlite"
)
Assert-Files -Root $DistDir -RelativePaths $CriticalFiles -Context "dist\ (scripts\build.ps1 output)"

# ---- 2. Assemble installer\payload\ ----------------------------------------
if (Test-Path -LiteralPath $PayloadDir) {
    Remove-Item -LiteralPath $PayloadDir -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $PayloadDir | Out-Null

Invoke-Robocopy (Join-Path $DistDir ".tools\php")      (Join-Path $PayloadDir ".tools\php")
Invoke-Robocopy (Join-Path $DistDir "redist\caddy")    (Join-Path $PayloadDir "redist\caddy")
Invoke-Robocopy (Join-Path $DistDir "app\npl_internal") (Join-Path $PayloadDir "app\npl_internal") `
    -ExtraArgs @("/XD", "tests", "node_modules", "/XF", "*.log")

foreach ($rootFile in @("NPLPokerOS.exe", "Caddyfile", "ConfigureStaffGateway.ps1")) {
    Copy-Item -LiteralPath (Join-Path $DistDir $rootFile) -Destination (Join-Path $PayloadDir $rootFile) -Force
}

# An un-checkpointed WAL means the .sqlite file alone is not the database.
# Shipping it would install a silently incomplete seed -- refuse outright.
$Sidecars = Get-ChildItem -Path (Join-Path $PayloadDir "app\npl_internal\database") -Filter "*.sqlite-*" -ErrorAction SilentlyContinue
if ($Sidecars) {
    throw "database.sqlite has WAL/SHM sidecars ($($Sidecars.Name -join ', ')). Rebuild so the database closes cleanly before packaging."
}

# The mahjong installer once shipped a truncated payload -- verify BEFORE
# compiling, including sanity minimum sizes on the two big executables.
Assert-Files -Root $PayloadDir -RelativePaths $CriticalFiles -Context "installer\payload\"
if ((Get-Item (Join-Path $PayloadDir "NPLPokerOS.exe")).Length -lt 5MB) { throw "NPLPokerOS.exe in the payload is implausibly small -- truncated build?" }
if ((Get-Item (Join-Path $PayloadDir ".tools\php\php.exe")).Length -lt 1MB) { throw "php.exe in the payload is implausibly small -- truncated copy?" }

# ---- 3. Setup wizard icon from winres PNGs ---------------------------------
# The repo has no .ico (app\npl_internal\public\favicon.ico is empty); pack
# the winres PNGs into a PNG-compressed .ico (valid on Vista+, we require 10+).
$IconFile = Join-Path $InstallerDir "app.ico"
if (-not (Test-Path -LiteralPath $IconFile)) {
    $PngPaths = @(16, 32, 48, 64, 128, 256) |
        ForEach-Object { Join-Path $RepoRoot "winres\icon$_.png" } |
        Where-Object { Test-Path -LiteralPath $_ }
    if ($PngPaths.Count -gt 0) {
        $stream = New-Object System.IO.MemoryStream
        $writer = New-Object System.IO.BinaryWriter($stream)
        $writer.Write([uint16]0); $writer.Write([uint16]1); $writer.Write([uint16]$PngPaths.Count)
        $images = foreach ($png in $PngPaths) {
            $bytes = [System.IO.File]::ReadAllBytes($png)
            # Width/height live big-endian in the PNG IHDR at offsets 16 and 20.
            $w = ([int]$bytes[16] -shl 24) -bor ([int]$bytes[17] -shl 16) -bor ([int]$bytes[18] -shl 8) -bor [int]$bytes[19]
            $h = ([int]$bytes[20] -shl 24) -bor ([int]$bytes[21] -shl 16) -bor ([int]$bytes[22] -shl 8) -bor [int]$bytes[23]
            [pscustomobject]@{ Bytes = $bytes; Width = $w; Height = $h }
        }
        $offset = 6 + 16 * $images.Count
        foreach ($img in $images) {
            $writer.Write([byte]$(if ($img.Width -ge 256) { 0 } else { $img.Width }))
            $writer.Write([byte]$(if ($img.Height -ge 256) { 0 } else { $img.Height }))
            $writer.Write([byte]0); $writer.Write([byte]0)          # palette, reserved
            $writer.Write([uint16]1); $writer.Write([uint16]32)     # planes, bpp
            $writer.Write([uint32]$img.Bytes.Length); $writer.Write([uint32]$offset)
            $offset += $img.Bytes.Length
        }
        foreach ($img in $images) { $writer.Write($img.Bytes) }
        [System.IO.File]::WriteAllBytes($IconFile, $stream.ToArray())
        $writer.Dispose()
        Write-Host "Generated $IconFile from winres PNGs."
    } else {
        Write-Warning "No winres\icon*.png found -- the setup exe will use the default Inno icon."
    }
}

# ---- 4. Compile with Inno Setup --------------------------------------------
$IsccCandidates = @(
    "C:\Program Files (x86)\Inno Setup 6\ISCC.exe",
    "C:\Program Files\Inno Setup 6\ISCC.exe",
    (Join-Path $env:LOCALAPPDATA "Programs\Inno Setup 6\ISCC.exe")
)
$Iscc = $IsccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $Iscc) {
    $Iscc = (Get-Command "ISCC.exe" -ErrorAction SilentlyContinue).Source
}
if (-not $Iscc) {
    throw "ISCC.exe not found. Install Inno Setup 6 (https://jrsoftware.org/isinfo.php)."
}

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
& $Iscc "/DMyAppVersion=$Version" "/O$OutputDir" $IssFile
if ($LASTEXITCODE -ne 0) { throw "ISCC failed ($LASTEXITCODE)." }

# ---- 5. Integrity report ----------------------------------------------------
$SetupExe = Join-Path $OutputDir "NPLPokerOS-Setup-$Version.exe"
if (-not (Test-Path -LiteralPath $SetupExe)) { throw "Expected installer not found at $SetupExe." }

# Guard against reading a file another process is still writing (the exact
# failure mode that shipped a broken mahjong installer): size must be stable.
$sizeA = (Get-Item -LiteralPath $SetupExe).Length
Start-Sleep -Seconds 2
$sizeB = (Get-Item -LiteralPath $SetupExe).Length
if ($sizeA -ne $sizeB) { throw "$SetupExe is still being written ($sizeA -> $sizeB bytes). Is another build running?" }

$Hash = (Get-FileHash -LiteralPath $SetupExe -Algorithm SHA256).Hash
Set-Content -LiteralPath "$SetupExe.sha256" -Value "$Hash  $(Split-Path -Leaf $SetupExe)" -Encoding ascii

Write-Host ""
Write-Host "Installer : $SetupExe"
Write-Host ("Size      : {0:N1} MB" -f ($sizeB / 1MB))
Write-Host "SHA256    : $Hash"
Write-Host ""
Write-Host "Verify on the target laptop before running:"
Write-Host "  certutil -hashfile `"$(Split-Path -Leaf $SetupExe)`" SHA256"
