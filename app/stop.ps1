$ErrorActionPreference = 'SilentlyContinue'

$appRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = (Resolve-Path (Join-Path $appRoot 'runtime\node\node.exe')).Path
$pidFile = Join-Path $appRoot 'service-pids.json'

if (Test-Path -LiteralPath $pidFile) {
    $records = @(Get-Content -LiteralPath $pidFile -Raw | ConvertFrom-Json)
    foreach ($record in $records) {
        $process = Get-Process -Id $record.Id -ErrorAction SilentlyContinue
        if ($process -and $process.Path -eq $nodeExe) {
            Stop-Process -Id $process.Id
        }
    }
}

Write-Host 'Huiji Local VisualEditor services stopped.'
