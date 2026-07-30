[CmdletBinding()]
param(
    [string]$Version = "0.1.0-dev",
    [string]$ReferenceBundle = "C:\Users\kylec\dist\EdgeHost_bundle"
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

# ---- Complete portable install bundle ----------------------------------
# A staff laptop gets dist\ copied onto it and double-clicks the exe.
# Nothing on the machine is assumed except the WebView2 runtime: the
# bundle carries the app, the PHP backend, a portable PHP, a fresh
# migrated database, and its own .env.

# 1. The host executable.
Copy-Item -LiteralPath (Join-Path $RepoRoot "NPLPokerOS.exe") -Destination (Join-Path $OutputDirectory "NPLPokerOS.exe") -Force

# 2. Portable PHP at .tools\php - where backendPHPBinary() looks first.
$PhpSource = Join-Path $ReferenceBundle "redist\php"
if (-not (Test-Path -LiteralPath (Join-Path $PhpSource "php.exe"))) {
    throw "Portable PHP not found at '$PhpSource' - set -ReferenceBundle."
}
$PhpTarget = Join-Path $OutputDirectory ".tools\php"
robocopy $PhpSource $PhpTarget /MIR /NFL /NDL /NJH /NJS | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying portable PHP failed (robocopy $LASTEXITCODE)." }
$LASTEXITCODE = 0

# 3. The bundled Laravel backend - dev database, dev env, caches and
#    tests stay behind.
$BackendSource = Join-Path $RepoRoot "app\npl_internal"
$BackendTarget = Join-Path $OutputDirectory "app\npl_internal"
robocopy $BackendSource $BackendTarget /MIR /NFL /NDL /NJH /NJS `
    /XD "tests" "node_modules" `
    /XF ".env" "database.sqlite" "*.log" | Out-Null
if ($LASTEXITCODE -ge 8) { throw "Copying the bundled backend failed (robocopy $LASTEXITCODE)." }
$LASTEXITCODE = 0

# 4. Fresh env + key, fresh migrated database. Every install starts clean;
#    venue data arrives via licence activation and Manual update.
$BundledPhp = Join-Path $PhpTarget "php.exe"
Push-Location $BackendTarget
try {
    Copy-Item -LiteralPath ".env.example" -Destination ".env" -Force
    & $BundledPhp artisan key:generate --force | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "key:generate failed in the bundle." }

    New-Item -ItemType File -Force -Path "database\database.sqlite" | Out-Null
    & $BundledPhp artisan migrate --force
    if ($LASTEXITCODE -ne 0) { throw "Migrations failed in the bundle." }
} finally {
    Pop-Location
}

Write-Host "Build complete. Portable install bundle: $OutputDirectory"
Write-Host "Copy the dist folder to a venue laptop and run NPLPokerOS.exe."
