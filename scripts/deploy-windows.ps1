[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Config,
  [ValidateSet('Check', 'Apply')]
  [string]$Mode = 'Check'
)

$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
$configPath = (Resolve-Path -LiteralPath $Config -ErrorAction Stop).ProviderPath
& $nodeCommand.Source (Join-Path $PSScriptRoot 'deploy-windows.mjs') $Mode.ToLowerInvariant() --config $configPath
exit $LASTEXITCODE
