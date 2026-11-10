# Starts the POS lab (Kafka, Kafka UI, Postgres, Splunk, producer, sinks).
# Run from the lab folder:  .\Start-Lab.ps1
# Start the POS simulator first (START_POS_SIMULATOR.bat) so the producer has data to read.

$ErrorActionPreference = 'Stop'
Set-Location $PSScriptRoot

docker info *> $null
if ($LASTEXITCODE -ne 0) { Write-Host 'Docker Desktop is not running. Start it and try again.' -ForegroundColor Red; exit 1 }

try { Invoke-RestMethod http://localhost:3001/api/health -TimeoutSec 3 | Out-Null; Write-Host 'POS simulator: running' -ForegroundColor Green }
catch { Write-Host 'POS simulator: not running (start it with START_POS_SIMULATOR.bat; the lab will pick it up when it is)' -ForegroundColor Yellow }

Write-Host "`nStarting containers (first run downloads ~2 GB of images)..." -ForegroundColor Cyan
docker compose up -d --build
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

Write-Host "`nWaiting for Splunk (2-4 minutes on first start)..." -ForegroundColor Cyan
$deadline = (Get-Date).AddMinutes(8)
do {
  Start-Sleep 10
  $state = docker inspect -f '{{.State.Health.Status}}' pos-splunk 2>$null
  Write-Host "  splunk: $state"
} until ($state -eq 'healthy' -or (Get-Date) -gt $deadline)

Write-Host @"

POS Lab is up
  Splunk dashboard  http://localhost:8000/en-US/app/pos_lab/pos_overview   (admin / PosLab#2026)
  Kafka UI          http://localhost:8080                                  (topic: pos.transactions)
  Risk console      http://localhost:3002                                  (fraud alerts, blocks, disputes)
  Postgres          localhost:5432  db/user/pass: poslab

Next
  docker compose run --rm traffic                  # send 100 transactions
  docker compose run --rm -e COUNT=500 traffic     # send 500
  docker compose run --rm verify                   # end-to-end data sync check
  docker compose run --rm fraud-scenarios          # fraud & chargeback test suite
  docker compose run --rm java-tests               # Java: REST Assured + Cucumber + Selenium
  docker compose logs -f tx-producer tx-sinks      # watch the pipeline
  .\Stop-Lab.ps1                                   # stop everything
"@ -ForegroundColor Green
