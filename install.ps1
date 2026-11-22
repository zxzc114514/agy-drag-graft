param([switch]$RegisterConfig)
$ErrorActionPreference = 'Stop'
$py = Get-Command python -ErrorAction SilentlyContinue
if (-not $py) { throw 'Python 3.10+ is required. Install Python, then run this script again.' }
$argsList = @((Join-Path $PSScriptRoot 'manage.py'), 'install')
if ($RegisterConfig) { $argsList += '--register-config' }
& $py.Source @argsList
if ($LASTEXITCODE -ne 0) { throw 'AGY Drag Graft installation failed. See the error above.' }
