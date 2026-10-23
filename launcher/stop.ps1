# Stops the local Project Tracker server started by serve.ps1 (records are not affected).
param([int]$Port = 4173)
$TokenFile = Join-Path $PSScriptRoot '.server-token'
if (-not (Test-Path $TokenFile)) { Write-Host "The Project Tracker server does not appear to be running."; exit 0 }
$token = (Get-Content $TokenFile -Raw).Trim()
try {
  Invoke-WebRequest -UseBasicParsing -Uri "http://localhost:$Port/__tracker_shutdown?token=$token" -TimeoutSec 5 | Out-Null
  Write-Host "Project Tracker server stopped."
} catch {
  Write-Host "Could not reach the server (it may already be stopped): $($_.Exception.Message)"
  Remove-Item -LiteralPath $TokenFile -ErrorAction SilentlyContinue
}
