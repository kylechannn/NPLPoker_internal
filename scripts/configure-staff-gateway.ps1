[CmdletBinding()]
param(
    [ValidateRange(1024, 65535)]
    [int]$Port = 8790,
    [string]$CaddyPath = "",
    [switch]$Remove
)

$ErrorActionPreference = "Stop"
$RuleName = "NPL Poker Staff Gateway $Port"

$Principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $Principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Administrator access is required to configure the Windows Firewall rule."
}

Get-NetFirewallRule -DisplayName $RuleName -ErrorAction SilentlyContinue |
    Remove-NetFirewallRule

if ($Remove) {
    Write-Host "Removed Windows Firewall rule: $RuleName"
    exit 0
}

$Rule = @{
    DisplayName   = $RuleName
    Description   = "Allows NPL staff phones on the local venue subnet to reach the route-limited QR login gateway."
    Direction     = "Inbound"
    Action        = "Allow"
    Protocol      = "TCP"
    LocalPort     = $Port
    RemoteAddress = "LocalSubnet"
    Profile       = "Any"
}

if ($CaddyPath) {
    $ResolvedCaddy = (Resolve-Path -LiteralPath $CaddyPath).Path
    $Rule.Program = $ResolvedCaddy
}

New-NetFirewallRule @Rule | Out-Null
Write-Host "Configured Windows Firewall rule: $RuleName (TCP $Port, LocalSubnet only)"
