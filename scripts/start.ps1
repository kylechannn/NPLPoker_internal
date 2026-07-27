[CmdletBinding()]
param(
    [switch]$Build
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $PSScriptRoot
$Executable = Join-Path $RepoRoot "dist\NPLPokerInternal.exe"

if ($Build -or -not (Test-Path -LiteralPath $Executable)) {
    & (Join-Path $PSScriptRoot "build.ps1")
}

Start-Process -FilePath $Executable -WorkingDirectory (Split-Path -Parent $Executable)
Write-Host "NPL Poker Operational System started."
