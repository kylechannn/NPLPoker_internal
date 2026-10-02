[CmdletBinding()]
param([Parameter(Mandatory = $true)][string]$TestRoot)
$ErrorActionPreference = 'Stop'
$testPath = [IO.Path]::GetFullPath($TestRoot)
if (Test-Path -LiteralPath $testPath) { throw 'TestRoot must be a new directory.' }
$source = Join-Path $testPath 'source'
$target = Join-Path $testPath 'review'
$app = Join-Path $source 'app\npl_internal'
foreach ($directory in @('.tools\php', 'app\npl_internal\app', 'app\npl_internal\bootstrap\cache', 'app\npl_internal\config', 'app\npl_internal\database\migrations', 'app\npl_internal\public', 'app\npl_internal\resources', 'app\npl_internal\routes', 'app\npl_internal\vendor', 'app\npl_internal\storage\app\private')) {
    New-Item -ItemType Directory -Path (Join-Path $source $directory) -Force | Out-Null
}
foreach ($file in @('NPLPokerOS.exe', '.tools\php\php.exe', 'app\npl_internal\artisan', 'app\npl_internal\vendor\autoload.php', 'app\npl_internal\composer.json', 'app\npl_internal\composer.lock')) {
    [IO.File]::WriteAllText((Join-Path $source $file), 'fixture program file')
}
[IO.File]::WriteAllText((Join-Path $app '.env.example'), "APP_KEY=`nAPP_ENV=local`nAPP_DEBUG=true`nDB_CONNECTION=sqlite`n")
foreach ($file in @('.env', 'database\database.sqlite', 'database\database.sqlite-wal', 'bootstrap\cache\config.php', 'storage\app\private\venue-secret.txt')) {
    [IO.File]::WriteAllText((Join-Path $app $file), 'venue-secret-do-not-copy')
}
[IO.File]::WriteAllText((Join-Path $source 'license.json'), 'venue-secret-do-not-copy')
$support = @{ schema = 1; executable_sha256 = (Get-FileHash -LiteralPath (Join-Path $source 'NPLPokerOS.exe') -Algorithm SHA256).Hash } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $source 'review-profile-support.json'), $support)
$prepare = Join-Path (Split-Path -Parent $PSScriptRoot) 'prepare-app-review.ps1'
& $prepare -BundlePath $source -Destination $target
$reviewApp = Join-Path $target 'app\npl_internal'
foreach ($forbidden in @('license.json', 'app\npl_internal\database\database.sqlite-wal', 'app\npl_internal\bootstrap\cache\config.php', 'app\npl_internal\storage\app\private\venue-secret.txt')) {
    if (Test-Path -LiteralPath (Join-Path $target $forbidden)) { throw "Copied venue state: $forbidden" }
}
if ((Get-Item -LiteralPath (Join-Path $reviewApp 'database\database.sqlite')).Length -ne 0) { throw 'Database is not empty.' }
$reviewEnv = Get-Content -LiteralPath (Join-Path $reviewApp '.env') -Raw
if ($reviewEnv -notmatch 'APP_KEY=base64:[A-Za-z0-9+/]+=*' -or $reviewEnv -match 'venue-secret') { throw 'Review environment was not freshly generated.' }
$marker = Get-Content -LiteralPath (Join-Path $target 'npl-app-review-profile.json') -Raw | ConvertFrom-Json
if ($marker.profile_id -notmatch '^[a-f0-9]{32}$') { throw 'Invalid profile marker.' }
$refused = $false
try { & $prepare -BundlePath $source -Destination $target } catch { $refused = $true }
if (-not $refused) { throw 'Preparation overwrote an existing profile.' }
$refused = $false
[IO.File]::WriteAllText((Join-Path $source 'NPLPokerOS.exe'), 'older executable without isolation support')
try { & $prepare -BundlePath $source -Destination (Join-Path $testPath 'old-build-review') } catch { $refused = $true }
if (-not $refused) { throw 'Preparation accepted an executable with mismatched isolation support.' }
Write-Host "PASS: fresh review copy isolates venue state; existing destination refused. Fixtures retained at $testPath"
