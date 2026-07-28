[CmdletBinding()]
param(
    [string]$Version = "0.1.0-dev"
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$OutputDirectory = Join-Path $RepoRoot "dist"
$CaddySource = Join-Path $RepoRoot ".tools\caddy\caddy.exe"
$NodePath = (Get-Command node -ErrorAction Stop).Source
$NpmCmd = Join-Path (Split-Path -Parent $NodePath) "npm.cmd"
$NpmPath = if (Test-Path -LiteralPath $NpmCmd) { $NpmCmd } else { (Get-Command npm -ErrorAction Stop).Source }

$NodeModules = Join-Path $RepoRoot "ui\node_modules"
if (Test-Path -LiteralPath $NodeModules) {
    & (Join-Path $PSScriptRoot "setup.ps1") -SkipDependencies
} else {
    & (Join-Path $PSScriptRoot "setup.ps1")
}

Push-Location (Join-Path $RepoRoot "ui")
try {
    & $NpmPath run build
    if ($LASTEXITCODE -ne 0) {
        throw "React build failed."
    }
} finally {
    Pop-Location
}

Push-Location $RepoRoot
try {
    go test ./...
    if ($LASTEXITCODE -ne 0) {
        throw "Go tests failed."
    }

    New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
    # rsrc_windows_amd64.syso (committed; regenerate with `go-winres make --in winres/winres.json --arch amd64`)
    # embeds the NPL icon, the application manifest and version info into the exe.
    go build -trimpath -ldflags "-s -w -H=windowsgui -X main.version=$Version" -o (Join-Path $RepoRoot "NPLPokerOS.exe") .
    if ($LASTEXITCODE -ne 0) {
        throw "Go build failed."
    }
} finally {
    Pop-Location
}

$CaddyOutputDirectory = Join-Path $OutputDirectory "redist\caddy"
New-Item -ItemType Directory -Force -Path $CaddyOutputDirectory | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $OutputDirectory "logs") | Out-Null
Copy-Item -LiteralPath $CaddySource -Destination (Join-Path $CaddyOutputDirectory "caddy.exe") -Force
Copy-Item -LiteralPath (Join-Path $RepoRoot "Caddyfile") -Destination (Join-Path $OutputDirectory "Caddyfile") -Force
Copy-Item -LiteralPath (Join-Path $PSScriptRoot "configure-staff-gateway.ps1") -Destination (Join-Path $OutputDirectory "ConfigureStaffGateway.ps1") -Force

Push-Location $OutputDirectory
try {
    & (Join-Path $CaddyOutputDirectory "caddy.exe") validate --config (Join-Path $OutputDirectory "Caddyfile") --adapter caddyfile
    if ($LASTEXITCODE -ne 0) {
        throw "Caddy configuration validation failed."
    }
} finally {
    Pop-Location
}

Write-Host "Build complete: $(Join-Path $RepoRoot 'NPLPokerOS.exe')"
