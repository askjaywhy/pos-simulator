# Window 3 - tests (opened by START_POS_SIMULATOR.ps1). -RunTests runs the ready suite at the end.
param([switch]$RunTests)
$Host.UI.RawUI.WindowTitle = 'POS Simulator - Tests'
Set-Location (Join-Path $PSScriptRoot '..\tests')

if (-not (Test-Path node_modules)) {
    Write-Host 'First run: installing test dependencies...' -ForegroundColor Cyan
    npm install
}
Write-Host 'Checking Playwright Chromium (downloads only the first time)...' -ForegroundColor Cyan
npx playwright install chromium

Write-Host ''
Write-Host 'Waiting for backend (:3001) and UI (:3000)...' -ForegroundColor Cyan
$deadline = (Get-Date).AddSeconds(120)
foreach ($url in 'http://localhost:3001/api/health', 'http://localhost:3000') {
    while ($true) {
        try {
            Invoke-WebRequest $url -UseBasicParsing -TimeoutSec 2 | Out-Null
            Write-Host "  up: $url" -ForegroundColor Green
            break
        } catch {
            if ((Get-Date) -gt $deadline) { Write-Host "  timed out: $url - check the other window for errors." -ForegroundColor Red; break }
            Start-Sleep -Seconds 1
        }
    }
}

Write-Host ''
Write-Host 'Agent guard self-test:' -ForegroundColor Cyan
node --test --test-reporter=dot ..\.claude\hooks\tests\guard.test.js
if ($LASTEXITCODE -eq 0) { Write-Host '  guard OK (9 checks)' -ForegroundColor Green }
else { Write-Host '  guard FAILED - see output above' -ForegroundColor Red }

Write-Host ''
Write-Host ('=' * 64) -ForegroundColor Green
Write-Host '  Ready. Commands (run here):' -ForegroundColor Green
Write-Host '    npm run test:ready     API + page-object UI tests (should all pass)' -ForegroundColor Green
Write-Host '    npm run test:agent-ui  only the page-object UI tests (tests\ui\agent)' -ForegroundColor Green
Write-Host '    npm test               everything' -ForegroundColor Green
Write-Host '    npm run report         open the last HTML report' -ForegroundColor Green
Write-Host ''
Write-Host '  Test agents:  cd ..  then  claude' -ForegroundColor Green
Write-Host ('=' * 64) -ForegroundColor Green

if ($RunTests) {
    Write-Host ''
    npm run test:ready
}
