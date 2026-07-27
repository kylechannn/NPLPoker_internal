[CmdletBinding()]
param(
    [string]$ReferenceBundle = "C:\Users\kylec\dist\EdgeHost_bundle",
    [switch]$SkipDependencies
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot

function Require-Command {
    param([string]$Name, [string]$InstallHint)

    $Command = Get-Command $Name -ErrorAction SilentlyContinue
    if ($null -eq $Command) {
        throw "$Name is required. $InstallHint"
    }
    return $Command
}

$Go = Require-Command "go" "Install Go 1.22 or newer from https://go.dev/dl/."
$Node = Require-Command "node" "Install Node.js 22 LTS or newer."
$Npm = Require-Command "npm" "Install npm with Node.js."
$GoPath = $Go.Source
$NodePath = $Node.Source
$NpmCmd = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
$NpmPath = if (Test-Path -LiteralPath $NpmCmd) { $NpmCmd } else { $Npm.Source }

$GoVersionOutput = & $GoPath version
if ($GoVersionOutput -notmatch "go(\d+)\.(\d+)") {
    throw "Could not determine the installed Go version: $GoVersionOutput"
}
$GoMajor = [int]$Matches[1]
$GoMinor = [int]$Matches[2]
if ($GoMajor -lt 1 -or ($GoMajor -eq 1 -and $GoMinor -lt 22)) {
    throw "Go 1.22 or newer is required; found $GoVersionOutput"
}

$CaddyTargetDirectory = Join-Path $RepoRoot ".tools\caddy"
$CaddyTarget = Join-Path $CaddyTargetDirectory "caddy.exe"
$ReferenceCaddy = Join-Path $ReferenceBundle "redist\caddy\caddy.exe"
$PathCaddy = Get-Command "caddy" -ErrorAction SilentlyContinue

New-Item -ItemType Directory -Force -Path $CaddyTargetDirectory | Out-Null
if (Test-Path -LiteralPath $ReferenceCaddy) {
    Copy-Item -LiteralPath $ReferenceCaddy -Destination $CaddyTarget -Force
} elseif ($null -ne $PathCaddy) {
    Copy-Item -LiteralPath $PathCaddy.Source -Destination $CaddyTarget -Force
} elseif (-not (Test-Path -LiteralPath $CaddyTarget)) {
    throw "Caddy was not found in '$ReferenceBundle' or on PATH."
}

Write-Host "Go:    $GoVersionOutput"
Write-Host "Node:  $(& $NodePath --version)"
Write-Host "npm:   $(& $NpmPath --version)"
Write-Host "Caddy: $(& $CaddyTarget version)"

if (-not $SkipDependencies) {
    Push-Location (Join-Path $RepoRoot "ui")
    try {
        if (Test-Path -LiteralPath "package-lock.json") {
            & $NpmPath ci
        } else {
            & $NpmPath install
        }
        if ($LASTEXITCODE -ne 0) {
            throw "npm dependency installation failed."
        }
    } finally {
        Pop-Location
    }

    Push-Location $RepoRoot
    try {
        & $GoPath mod download
        if ($LASTEXITCODE -ne 0) {
            throw "Go module download failed."
        }
    } finally {
        Pop-Location
    }
}

Write-Host "Setup complete."
