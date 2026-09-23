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
    } catch {
        return $false
    }
}

function Start-HiddenNode([string[]]$Arguments, [string]$WorkingDirectory, [string]$LogName) {
    $outLog = Join-Path $logRoot ($LogName + '.log')
    $errLog = Join-Path $logRoot ($LogName + '.error.log')
    return Start-Process -FilePath $nodeExe -ArgumentList $Arguments -WorkingDirectory $WorkingDirectory `
        -WindowStyle Hidden -RedirectStandardOutput $outLog -RedirectStandardError $errLog -PassThru
}

if (-not (Test-Path -LiteralPath $nodeExe) -or -not (Test-Path -LiteralPath $parsoidEntry)) {
    throw 'Runtime files are missing. Extract the complete HuijiLocalVisualEditor folder again.'
}

$started = @()
if (-not (Test-LocalService 'http://127.0.0.1:8143/_health')) {
    $started += Start-HiddenNode @($proxyScript) $appRoot 'huiji-api-proxy'
}
if (-not (Test-LocalService 'http://127.0.0.1:8142/_version')) {
    $started += Start-HiddenNode @($parsoidEntry, '-c', 'config.yaml') $parsoidRoot 'parsoid'
}

$deadline = (Get-Date).AddSeconds(35)
while ((Get-Date) -lt $deadline -and -not (Test-LocalService 'http://127.0.0.1:8142/_version')) {
    Start-Sleep -Milliseconds 300
}
if (-not (Test-LocalService 'http://127.0.0.1:8142/_version')) {
    throw "Local Parsoid failed to start. See $logRoot\parsoid.error.log"
}

if ($started.Count -gt 0) {
    @($started | ForEach-Object {
        [pscustomobject]@{ Id = $_.Id; Path = $nodeExe }
    }) | ConvertTo-Json | Set-Content -LiteralPath $pidFile -Encoding UTF8
}

if ($env:HUIJI_VE_NO_BROWSER -eq '1') {
    Write-Host 'Local services are ready.'
    exit 0
}

$edgeCandidates = @(
    "$env:ProgramFiles (x86)\Microsoft\Edge\Application\msedge.exe",
    "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
    "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe"
)
$edgeExe = $edgeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $edgeExe) {
    throw 'Microsoft Edge was not found.'
}

$pageUrl = if ($args.Count -gt 0) { [string]$args[0] } else {
    'https://unimage.huijiwiki.com/wiki/Ê×Ò³'
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
    '--no-first-run',
    '--no-default-browser-check',
    "--app=$pageUrl"
)
Start-Process -FilePath $edgeExe -ArgumentList $edgeArguments | Out-Null
