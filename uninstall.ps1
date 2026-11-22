param([switch]$CleanConfig)
$ErrorActionPreference = 'Stop'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { throw 'Python 3.10+ is required to uninstall AGY Drag Graft safely.' }
$argsList = @((Join-Path $PSScriptRoot 'manage.py'), 'uninstall')
if ($CleanConfig) { $argsList += '--clean-config' }
& $py.Source @argsList
if ($LASTEXITCODE -ne 0) { throw 'AGY Drag Graft uninstallation failed. See the error above.' }
