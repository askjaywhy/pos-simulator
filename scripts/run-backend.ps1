# Window 1 - backend API on :3001 (opened by START_POS_SIMULATOR.ps1)
$Host.UI.RawUI.WindowTitle = 'POS Simulator - Backend :3001'
Set-Location (Join-Path $PSScriptRoot '..\backend')
if (-not (Test-Path node_modules)) {
    Write-Host 'First run: installing backend dependencies...' -ForegroundColor Cyan
    npm install
}
Write-Host ''
Write-Host 'Starting backend on http://localhost:3001  (Ctrl+C to stop)' -ForegroundColor Green
npm start
