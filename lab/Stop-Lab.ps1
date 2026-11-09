# Stops the POS lab. Add -Wipe to also delete Postgres and Splunk data.
param([switch]$Wipe)
Set-Location $PSScriptRoot
if ($Wipe) { docker compose --profile tools down -v } else { docker compose --profile tools down }
