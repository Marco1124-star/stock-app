param(
    [switch]$NoBrowser,
    [switch]$ValidateOnly
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$backendDirectory = Join-Path $projectRoot "backend"
$frontendDirectory = Join-Path $projectRoot "frontend"
$backendApp = Join-Path $backendDirectory "app.py"
$frontendPackage = Join-Path $frontendDirectory "package.json"
$frontendModules = Join-Path $frontendDirectory "node_modules"
$backendPort = 5000
$frontendPort = 3000
$backendHealthUrl = "http://127.0.0.1:$backendPort/search/suggestions?q="

function Test-LocalPort {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [int]$TimeoutMilliseconds = 250
    )

    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $connection = $client.BeginConnect("127.0.0.1", $Port, $null, $null)
        if (-not $connection.AsyncWaitHandle.WaitOne($TimeoutMilliseconds, $false)) {
            return $false
        }

        $client.EndConnect($connection)
        return $true
    }
    catch {
        return $false
    }
    finally {
        $client.Close()
    }
}

function Test-HttpEndpoint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Url,
        [int]$TimeoutSeconds = 5
    )

    try {
        $response = Invoke-WebRequest `
            -UseBasicParsing `
            -Uri $Url `
            -Method Get `
            -TimeoutSec $TimeoutSeconds
        return ($response.StatusCode -ge 200 -and $response.StatusCode -lt 400)
    }
    catch {
        return $false
    }
}

function Find-Python {
    $venvPython = Join-Path $backendDirectory "venv\Scripts\python.exe"
    if (Test-Path -LiteralPath $venvPython) {
        return $venvPython
    }

    foreach ($commandName in @("py.exe", "python.exe")) {
        $command = Get-Command $commandName -ErrorAction SilentlyContinue
        if ($null -ne $command) {
            return $command.Source
        }
    }

    throw "Python non trovato. Installa Python oppure crea backend\venv."
}

if (-not (Test-Path -LiteralPath $backendApp)) {
    throw "Backend non trovato: $backendApp"
}

if (-not (Test-Path -LiteralPath $frontendPackage)) {
    throw "Frontend non trovato: $frontendPackage"
}

$pythonExe = Find-Python
$npmCommand = Get-Command "npm.cmd" -ErrorAction SilentlyContinue
if ($null -eq $npmCommand) {
    throw "npm non trovato. Installa Node.js e riprova."
}

if (-not (Test-Path -LiteralPath $frontendModules)) {
    throw "Dipendenze frontend mancanti. Esegui 'npm install' nella cartella frontend."
}

if ((Test-LocalPort -Port $frontendPort) -and -not (Test-HttpEndpoint -Url "http://127.0.0.1:$frontendPort")) {
    for ($candidatePort = 3001; $candidatePort -le 3010; $candidatePort++) {
        if (-not (Test-LocalPort -Port $candidatePort)) {
            $frontendPort = $candidatePort
            break
        }
    }
}

$appUrl = "http://localhost:$frontendPort"
$frontendHealthUrl = "http://127.0.0.1:$frontendPort"

if ($ValidateOnly) {
    Write-Host "Controllo completato: il launcher e' pronto." -ForegroundColor Green
    Write-Host "Python: $pythonExe"
    Write-Host "npm: $($npmCommand.Source)"
    exit 0
}

Write-Host ""
Write-Host "Avvio Stock App..." -ForegroundColor Cyan

$backendPortOpen = Test-LocalPort -Port $backendPort
$backendReady = Test-HttpEndpoint -Url $backendHealthUrl
if ($backendReady) {
    Write-Host "Backend gia' attivo sulla porta $backendPort."
}
elseif ($backendPortOpen) {
    throw "La porta $backendPort e' occupata, ma il backend Stock App non risponde. Chiudi il processo che la usa e riprova."
}
else {
    $backendCommand = 'title Stock App - Backend && set "FLASK_DEBUG=0" && set "PORT=' + $backendPort + '" && "' + $pythonExe + '" app.py'
    Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/k", $backendCommand) `
        -WorkingDirectory $backendDirectory `
        -WindowStyle Normal | Out-Null
    Write-Host "Backend avviato."
}

$frontendPortOpen = Test-LocalPort -Port $frontendPort
$frontendReady = Test-HttpEndpoint -Url $frontendHealthUrl
if ($frontendReady) {
    Write-Host "Frontend gia' attivo sulla porta $frontendPort."
}
elseif ($frontendPortOpen) {
    Write-Host "Frontend gia' in avvio sulla porta $frontendPort."
}
else {
    $frontendCommand = 'title Stock App - Frontend && set "BROWSER=none" && set "PORT=' + $frontendPort + '" && npm start'
    Start-Process `
        -FilePath "cmd.exe" `
        -ArgumentList @("/d", "/k", $frontendCommand) `
        -WorkingDirectory $frontendDirectory `
        -WindowStyle Normal | Out-Null
    Write-Host "Frontend avviato."
}

$deadline = (Get-Date).AddSeconds(120)
$lastStatusAt = Get-Date

while ((Get-Date) -lt $deadline) {
    if (-not $backendReady) {
        $backendReady = Test-HttpEndpoint -Url $backendHealthUrl
    }
    if (-not $frontendReady) {
        $frontendReady = Test-HttpEndpoint -Url $frontendHealthUrl
    }

    if ($backendReady -and $frontendReady) {
        break
    }

    if (((Get-Date) - $lastStatusAt).TotalSeconds -ge 10) {
        Write-Host "Attendo che i servizi siano pronti..."
        $lastStatusAt = Get-Date
    }

    Start-Sleep -Milliseconds 500
}

if (-not $frontendReady) {
    throw "Il frontend non ha risposto entro 120 secondi. Controlla la finestra 'Stock App - Frontend'."
}

if (-not $backendReady) {
    Write-Warning "Il frontend e' pronto, ma il backend non risponde sulla porta $backendPort."
}

if (-not $NoBrowser) {
    Start-Process $appUrl
}

Write-Host "Stock App pronta: $appUrl" -ForegroundColor Green
