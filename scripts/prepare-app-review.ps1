[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$BundlePath,
    [Parameter(Mandatory = $true)][string]$Destination
)

$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path -LiteralPath $BundlePath).Path
$targetRoot = [System.IO.Path]::GetFullPath($Destination)
if (Test-Path -LiteralPath $targetRoot) { throw 'Destination must be a new directory. Existing review and venue data will not be overwritten.' }
if ($targetRoot.StartsWith($sourceRoot.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'Choose a review destination outside the source bundle.'
}
foreach ($required in @('NPLPokerOS.exe', '.tools\php\php.exe', 'app\npl_internal\artisan', 'app\npl_internal\.env.example', 'app\npl_internal\vendor\autoload.php')) {
    if (-not (Test-Path -LiteralPath (Join-Path $sourceRoot $required) -PathType Leaf)) { throw "Incomplete portable bundle: $required is missing. Build the current OS first." }
}
$supportFile = Join-Path $sourceRoot 'review-profile-support.json'
if (-not (Test-Path -LiteralPath $supportFile -PathType Leaf)) { throw 'This bundle does not declare isolated review-profile support. Build the current OS before preparing a review copy.' }
$support = Get-Content -LiteralPath $supportFile -Raw | ConvertFrom-Json
$executableHash = (Get-FileHash -LiteralPath (Join-Path $sourceRoot 'NPLPokerOS.exe') -Algorithm SHA256).Hash
if ($support.schema -ne 1 -or $support.executable_sha256 -ne $executableHash) { throw 'The review support manifest does not match this executable. Rebuild the portable bundle.' }

# Copy source code and dependencies, never a venue's environment, SQLite,
# licence, queued writes, sessions, browser data, uploads, or framework caches.
function Copy-ReviewTree([string]$Source, [string]$Target) {
    $rootItem = Get-Item -LiteralPath $Source -Force
    if ($rootItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing linked source: $Source" }
    New-Item -ItemType Directory -Path $Target -Force | Out-Null
    foreach ($item in Get-ChildItem -LiteralPath $Source -Force) {
        if ($item.Name -in @('.git', 'node_modules', 'storage', 'logs', 'tests')) { continue }
        if ($item.Name -like '.env*' -and $item.Name -ne '.env.example') { continue }
        if ($item.Name -like '*.sqlite*' -or $item.Name -like '*.log' -or $item.Name -eq 'license.json') { continue }
        if ($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw "Refusing linked source: $($item.FullName)" }
        if ($item.PSIsContainer) {
            if ($item.Name -eq 'cache' -and $rootItem.Name -eq 'bootstrap') { continue }
            Copy-ReviewTree $item.FullName (Join-Path $Target $item.Name)
        } else {
            Copy-Item -LiteralPath $item.FullName -Destination (Join-Path $Target $item.Name)
        }
    }
}

New-Item -ItemType Directory -Path $targetRoot | Out-Null
Copy-Item -LiteralPath (Join-Path $sourceRoot 'NPLPokerOS.exe') -Destination (Join-Path $targetRoot 'NPLPokerOS.exe')
Copy-ReviewTree (Join-Path $sourceRoot '.tools\php') (Join-Path $targetRoot '.tools\php')
$sourceApp = Join-Path $sourceRoot 'app\npl_internal'
$targetApp = Join-Path $targetRoot 'app\npl_internal'
foreach ($directory in @('app', 'bootstrap', 'config', 'database\migrations', 'public', 'resources', 'routes', 'vendor')) {
    Copy-ReviewTree (Join-Path $sourceApp $directory) (Join-Path $targetApp $directory)
}
Copy-Item -LiteralPath (Join-Path $sourceApp 'artisan') -Destination (Join-Path $targetApp 'artisan')
foreach ($file in @('composer.json', 'composer.lock', '.env.example')) {
    Copy-Item -LiteralPath (Join-Path $sourceApp $file) -Destination (Join-Path $targetApp $file)
}
foreach ($directory in @('bootstrap\cache', 'storage\app\private', 'storage\app\public', 'storage\framework\cache\data', 'storage\framework\sessions', 'storage\framework\views', 'storage\logs')) {
    New-Item -ItemType Directory -Path (Join-Path $targetApp $directory) -Force | Out-Null
}
[System.IO.File]::WriteAllBytes((Join-Path $targetApp 'database\database.sqlite'), [byte[]]@())
$randomBytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($randomBytes) } finally { $rng.Dispose() }
$appKey = 'base64:' + [Convert]::ToBase64String($randomBytes)
$reviewEnv = Get-Content -LiteralPath (Join-Path $targetApp '.env.example') -Raw
$reviewEnv = $reviewEnv -replace '(?m)^APP_KEY=.*$', "APP_KEY=$appKey"
$reviewEnv = $reviewEnv -replace '(?m)^APP_ENV=.*$', 'APP_ENV=production'
$reviewEnv = $reviewEnv -replace '(?m)^APP_DEBUG=.*$', 'APP_DEBUG=false'
$reviewEnv = $reviewEnv -replace '(?m)^LOG_LEVEL=.*$', 'LOG_LEVEL=warning'
[IO.File]::WriteAllText((Join-Path $targetApp '.env'), $reviewEnv, (New-Object Text.UTF8Encoding($false)))
$marker = @{ profile_id = [Guid]::NewGuid().ToString('N') } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $targetRoot 'npl-app-review-profile.json'), $marker, (New-Object Text.UTF8Encoding($false)))
$launcher = @'
$ErrorActionPreference = 'Stop'
# This starts only this separately prepared review copy. Its Go host validates
# the marker, selects private storage and ports, then opens the review window.
$previousReviewProfile = [Environment]::GetEnvironmentVariable('NPL_INTERNAL_REVIEW_PROFILE', 'Process')
try {
    $env:NPL_INTERNAL_REVIEW_PROFILE = '1'
    Start-Process -FilePath (Join-Path $PSScriptRoot 'NPLPokerOS.exe') -WorkingDirectory $PSScriptRoot -WindowStyle Hidden
} finally {
    [Environment]::SetEnvironmentVariable('NPL_INTERNAL_REVIEW_PROFILE', $previousReviewProfile, 'Process')
}
'@
[IO.File]::WriteAllText((Join-Path $targetRoot 'Start-AppReview.ps1'), $launcher, (New-Object Text.UTF8Encoding($false)))
$clickLauncher = '@echo off' + "`r`n" + '"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AppReview.ps1"' + "`r`n"
[IO.File]::WriteAllText((Join-Path $targetRoot 'Start-AppReview.cmd'), $clickLauncher, [Text.Encoding]::ASCII)
Write-Host "Prepared a fresh App Review copy at $targetRoot"
Write-Host 'Start it with Start-AppReview.cmd, activate the assigned review CD-Key, then sign in with review staff credentials and run Manual update.'
Write-Host 'No OS process has been started and no cloud data has been changed.'
