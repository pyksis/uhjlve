$ErrorActionPreference = 'Stop'

$appRoot = Split-Path -Parent $PSScriptRoot
$nodeExe = Join-Path $appRoot 'runtime\node\node.exe'
$proxyScript = Join-Path $appRoot 'app\huiji-api-proxy.js'
$parsoidRoot = Join-Path $appRoot 'runtime\parsoid'
$parsoidEntry = Join-Path $parsoidRoot 'node_modules\service-runner\service-runner.js'
$extensionRoot = Join-Path $appRoot 'extension'
$logRoot = Join-Path $appRoot 'logs'
$pidFile = Join-Path $appRoot 'service-pids.json'
New-Item -ItemType Directory -Force -Path $logRoot | Out-Null

function Test-LocalService([string]$Uri) {
    try {
        $response = Invoke-WebRequest -UseBasicParsing -Uri $Uri -TimeoutSec 2
        return $response.StatusCode -eq 200
    } catch { return $false }
}

function Start-HiddenNode([string[]]$Arguments, [string]$WorkingDirectory, [string]$LogName) {
    $outLog = Join-Path $logRoot ($LogName + '.log')
    $errLog = Join-Path $logRoot ($LogName + '.error.log')
    $quotedArguments = $Arguments | ForEach-Object { '"' + $_ + '"' }
    return Start-Process -FilePath $nodeExe -ArgumentList $quotedArguments -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
}

if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $parsoidEntry)) {
    throw 'Runtime files are missing. Extract the complete HuijiLocalVisualEditor folder again.'
}

# Re-running the launcher upgrades only this application's old proxy process.
if (Test-LocalService 'http://127.0.0.1:8143/_health') {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:8143/_health' -TimeoutSec 3
    if ($health.version -ne '1.0.4') {
        $owners = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -eq $nodeExe -and $_.CommandLine -like ('*' + $proxyScript + '*')
        })
        if ($owners.Count -eq 0) { throw 'Port 8143 belongs to another application. Stop that service first.' }
        $owners | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }
        Start-Sleep -Milliseconds 300
    }
}

# Old Parsoid processes do not have the browser relay routes loaded.
if (Test-LocalService 'http://127.0.0.1:8142/_version') {
    if (-not (Test-LocalService 'http://127.0.0.1:8142/_bridge/status')) {
        $owners = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -eq $nodeExe -and $_.CommandLine -like ('*' + $parsoidRoot + '*')
        })
        if ($owners.Count -eq 0) { throw 'Port 8142 belongs to another application. Stop that service first.' }
        $owners | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Start-Sleep -Milliseconds 300
    }
}

$started = @()
if (-not (Test-LocalService 'http://127.0.0.1:8143/_health')) {
    $started += Start-HiddenNode @($proxyScript) $appRoot 'huiji-api-proxy'
}
if (-not (Test-LocalService 'http://127.0.0.1:8142/_version')) {
    $started += Start-HiddenNode @($parsoidEntry, '-c', 'config.yaml') $parsoidRoot 'parsoid'
}

$deadline = (Get-Date).AddSeconds(35)
while ((Get-Date) -lt $deadline) {
    if ((Test-LocalService 'http://127.0.0.1:8143/_health') -and (Test-LocalService 'http://127.0.0.1:8142/_version')) { break }
    Start-Sleep -Milliseconds 300
}
if (-not (Test-LocalService 'http://127.0.0.1:8143/_health') -or -not (Test-LocalService 'http://127.0.0.1:8142/_version')) {
    throw "Local services failed to start. See $logRoot"
}

if ($started.Count -gt 0) {
    @($started | ForEach-Object { [pscustomobject]@{ Id = $_.Id; Path = $nodeExe } }) |
        ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
}
if ($env:HUIJI_VE_NO_BROWSER -eq '1') {
    Write-Host 'Local services are ready.'
    exit 0
}

$edgeCandidates = @(
    "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgeExe = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edgeExe) { throw 'Microsoft Edge was not found.' }

$pageUrl = if ($args.Count -gt 0) { [string]$args[0] } else {
    'https://unimage.huijiwiki.com/wiki/%E9%A6%96%E9%A1%B5'
}
if (-not $pageUrl.StartsWith('https://unimage.huijiwiki.com/')) {
    throw 'This build only opens pages under https://unimage.huijiwiki.com/.'
}
if ($pageUrl -notmatch '[?&]veaction=') {
    $pageUrl += $(if ($pageUrl.Contains('?')) { '&veaction=edit' } else { '?veaction=edit' })
}

$profileRoot = Join-Path $appRoot 'edge-profile'
$edgeArguments = @(
    "--user-data-dir=`"$profileRoot`"",
    "--disable-extensions-except=`"$extensionRoot`"",
    "--load-extension=`"$extensionRoot`"",
    '--no-first-run', '--no-default-browser-check', '--disable-background-mode'
)
if ($env:HUIJI_VE_BROWSER_TAB -eq '1') {
    $edgeArguments += @('--new-window', $pageUrl)
} else {
    $edgeArguments += "--app=$pageUrl"
}
Start-Process -FilePath $edgeExe -ArgumentList $edgeArguments | Out-Null
