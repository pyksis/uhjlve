$ErrorActionPreference = 'Stop'
$appRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Resolve-Path (Join-Path $appRoot 'runtime\node\node.exe')).Path
$proxyScript = Join-Path $appRoot 'app\huiji-api-proxy.js'
$parsoidRoot = Join-Path $appRoot 'runtime\parsoid'

# Include service-runner's worker processes; a parent-only stop leaves port 8142 busy.
$owned = @(Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -eq $nodeExe -and
    ($_.CommandLine -like ('*' + $proxyScript + '*') -or $_.CommandLine -like ('*' + $parsoidRoot + '*'))
})
$owned | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Write-Host 'Huiji Local VisualEditor services stopped.'
