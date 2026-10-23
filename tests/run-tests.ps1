# Runs the browser test suite headlessly in Microsoft Edge or Google Chrome and prints the results.
# Starts the local server if it is not already running. Uses a throw-away browser profile.
param([string]$Page = 'tests/index.html', [int]$TimeoutSec = 120)
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Import-Module (Join-Path $PSScriptRoot 'cdp.psm1') -Force
if (-not (Get-BrowserPath)) { Write-Host 'Edge or Chrome is required to run the browser tests.'; exit 1 }
$started = $null
try { $ok = (Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 2).Content -eq 'engineeredplans-project-tracker' } catch { $ok = $false }
if (-not $ok) {
  $started = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Root\launcher\serve.ps1`"", '-NoBrowser' -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; try { if ((Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 1).Content) { break } } catch {} }
}
$profileDir = Join-Path $env:TEMP ('spt-test-profile-' + [guid]::NewGuid().ToString('N'))
$code = 1
try {
  Start-CdpBrowser -ProfileDir $profileDir
  Open-CdpUrl "http://localhost:4173/$Page"
  Wait-Js "document.body && !!document.body.dataset.done" $TimeoutSec | Out-Null
  Start-Sleep -Milliseconds 500
  Invoke-Js "document.getElementById('results').textContent"
  if ((Invoke-Js "document.body.dataset.done") -eq 'pass') { $code = 0 }
} finally {
  Stop-CdpBrowser
  if ($started) { & "$Root\launcher\stop.ps1" | Out-Null }
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
exit $code
