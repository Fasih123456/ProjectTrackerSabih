# J1 persistence check: records submitted through the app survive page reload, full browser close,
# and a server stop/restart, when reopened with the same browser profile and the same origin.
# Uses an isolated test database inside a throw-away browser profile.
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Import-Module (Join-Path $PSScriptRoot 'cdp.psm1') -Force
$profileDir = Join-Path $env:TEMP ('spt-persist-profile-' + [guid]::NewGuid().ToString('N'))
$db = 'engineeredplans_test_persist'
$url = "http://localhost:4173/?db=$db#/dashboard"
function Start-Server { $p = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Root\launcher\serve.ps1`"", '-NoBrowser' -WindowStyle Hidden -PassThru; for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; try { if ((Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 1).Content) { return } } catch {} }; throw 'server did not start' }
$snapshot = "(async()=>{ const { app } = await import('/js/ui/state.js'); const d = await app.db.loadAll(); return JSON.stringify(d); })()"
$out = @()
try {
  Start-Server
  Start-CdpBrowser -ProfileDir $profileDir
  Open-CdpUrl $url; Wait-Js "document.body.dataset.ready === 'true'" 20 | Out-Null
  Invoke-Js @"
(async()=>{ const { app } = await import('/js/ui/state.js');
  const c = await app.db.create('clients', { ClientName: 'Persist Co', IsInternal: false });
  const p = await app.db.create('projects', { ClientID: c.ClientID, ProjectName: 'Persist Project', ProjectType: 'Client' });
  await app.db.create('income', { ProjectID: p.ProjectID, StartDate: '2026-09-01', AmountPaid: '118481.8780', IncomeNotes: 'four decimals' });
  const e = await app.db.create('people', { PersonName: 'Persist Person', MonthlyReferenceValue: '320000.0000', ReferenceHours: 160, JoinDate: '2099-01-01', IBAN: 'PK00  KEEP  SPACES' });
  await app.db.create('timeEntries', { WorkDate: '2026-09-02', ProjectID: p.ProjectID, PersonID: e.PersonID, HoursWorked: 24.07, HoursBilled: 3.3, RateOverride: '0.0000' });
  return true; })()
"@ | Out-Null
  $before = Invoke-Js $snapshot
  Open-CdpUrl $url; Wait-Js "document.body.dataset.ready === 'true'" 20 | Out-Null
  $afterReload = Invoke-Js $snapshot
  $out += if ($afterReload -eq $before) { 'PASS  identical after page reload' } else { 'FAIL  differs after page reload' }
  Stop-CdpBrowser
  & "$Root\launcher\stop.ps1" | Out-Null
  Start-Sleep -Seconds 1
  $down = $false; try { Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 1 | Out-Null } catch { $down = $true }
  $out += if ($down) { 'PASS  server stopped' } else { 'FAIL  server still running' }
  Start-Server
  Start-CdpBrowser -ProfileDir $profileDir
  Open-CdpUrl $url; Wait-Js "document.body.dataset.ready === 'true'" 20 | Out-Null
  $afterRestart = Invoke-Js $snapshot
  $out += if ($afterRestart -eq $before) { 'PASS  identical after full browser close + server restart (same profile, same origin)' } else { 'FAIL  differs after browser close + server restart' }
  $counts = Invoke-Js "(async()=>{ const { app } = await import('/js/ui/state.js'); const d = await app.db.loadAll(); return [d.clients.length, d.projects.length, d.income[0].AmountPaid, d.people[0].IBAN, d.timeEntries[0].HoursWorked].join(' | '); })()"
  $out += "      stored: clients | projects | amount | IBAN | hours = $counts"
  Invoke-Js "(async()=>{ const { app } = await import('/js/ui/state.js'); app.db.close(); await new Promise(r => { const q = indexedDB.deleteDatabase('$db'); q.onsuccess = q.onerror = q.onblocked = () => r(); }); return true; })()" | Out-Null
} finally {
  Stop-CdpBrowser
  & "$Root\launcher\stop.ps1" | Out-Null
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
  $out -join "`n"
}
