# POS Simulator - 3-window launcher (PowerShell)
#
#   .\Start-POS-Simulator.ps1              open backend, UI and tests windows
#   .\Start-POS-Simulator.ps1 -RunTests    same, then run the "ready" suite automatically
#
# If scripts are blocked, double-click START_POS_SIMULATOR.bat instead.
# Each window runs one plain script from the scripts\ folder.

param([switch]$RunTests)

$root = $PSScriptRoot
$scripts = Join-Path $root 'scripts'

function Test-PortInUse($port) {
    [bool](Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

function Open-Window($scriptName, $extraArgs = @()) {
    $file = Join-Path $scripts $scriptName
    $argList = @('-NoExit', '-ExecutionPolicy', 'Bypass', '-File', "`"$file`"") + $extraArgs
    Start-Process powershell -ArgumentList $argList
}

Write-Host ''
Write-Host ('=' * 64) -ForegroundColor Cyan
Write-Host '  POS Simulator - starting all services' -ForegroundColor Cyan
Write-Host ('=' * 64) -ForegroundColor Cyan
Write-Host "Project: $root" -ForegroundColor Green

# --- Preflight -------------------------------------------------------------------
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Host 'Node.js was not found on PATH. Install it from https://nodejs.org and try again.' -ForegroundColor Red
    exit 1
}
foreach ($s in 'run-backend.ps1', 'run-ui.ps1', 'run-tests.ps1') {
    if (-not (Test-Path (Join-Path $scripts $s))) {
        Write-Host "Missing scripts\$s - it may have been removed by antivirus. Restore it and try again." -ForegroundColor Red
        exit 1
    }
}
$busy = @(3000, 3001) | Where-Object { Test-PortInUse $_ }
if ($busy) {
    Write-Host ''
    Write-Host ("Port(s) " + ($busy -join ', ') + " already in use - a simulator window from an earlier run is probably still open.") -ForegroundColor Yellow
    Write-Host 'Close those windows (or press Ctrl+C in them) and run this again.' -ForegroundColor Yellow
    exit 1
}

# --- Open the three windows ----------------------------------------------------------
Write-Host ''
Write-Host '[1/3] Backend API  (http://localhost:3001)' -ForegroundColor Yellow
Open-Window 'run-backend.ps1'

Write-Host '[2/3] Terminal UI  (http://localhost:3000)' -ForegroundColor Yellow
Open-Window 'run-ui.ps1'

Write-Host '[3/3] Tests' -ForegroundColor Yellow
if ($RunTests) { Open-Window 'run-tests.ps1' @('-RunTests') } else { Open-Window 'run-tests.ps1' }

# --- Open the browser once the UI is serving -----------------------------------------
Write-Host ''
Write-Host 'Waiting for the UI to come up before opening the browser...' -ForegroundColor Gray
$deadline = (Get-Date).AddSeconds(60)
while (-not (Test-PortInUse 3000) -and (Get-Date) -lt $deadline) { Start-Sleep -Seconds 1 }
Start-Process 'http://localhost:3000'

Write-Host ''
Write-Host '  All 3 windows are open:' -ForegroundColor Green
Write-Host '    Backend API   http://localhost:3001' -ForegroundColor Green
Write-Host '    Terminal UI   http://localhost:3000' -ForegroundColor Green
Write-Host '    Tests         see the Tests window for commands' -ForegroundColor Green
Write-Host ''
