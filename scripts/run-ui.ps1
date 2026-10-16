# Window 2 - terminal UI on :3000 (opened by Start-POS-Simulator.ps1)
# Served by scripts\serve-ui.js (Node) - no Python needed.
$Host.UI.RawUI.WindowTitle = 'POS Simulator - UI :3000'
Set-Location $PSScriptRoot
node serve-ui.js
