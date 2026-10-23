# UI smoke/workflow test: drives the real app in headless Edge/Chrome against an isolated test database.
# Visits every navigation destination, performs CRUD through the forms, checks Cancel/Submit, dirty guards,
# bank-details switching, reports, and writes screenshots/PDFs to the output folder.
param([string]$OutDir = (Join-Path $env:TEMP 'spt-ui-out'))
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Import-Module (Join-Path $PSScriptRoot 'cdp.psm1') -Force
New-Item -ItemType Directory -Force $OutDir | Out-Null
$started = $null
try { $ok = (Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 2).Content -eq 'engineeredplans-project-tracker' } catch { $ok = $false }
if (-not $ok) {
  $started = Start-Process powershell -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$Root\launcher\serve.ps1`"", '-NoBrowser' -WindowStyle Hidden -PassThru
  for ($i = 0; $i -lt 40; $i++) { Start-Sleep -Milliseconds 250; try { if ((Invoke-WebRequest -UseBasicParsing 'http://localhost:4173/__tracker_ping' -TimeoutSec 1).Content) { break } } catch {} }
}
$profileDir = Join-Path $env:TEMP ('spt-ui-profile-' + [guid]::NewGuid().ToString('N'))
$db = 'engineeredplans_test_ui_' + [guid]::NewGuid().ToString('N').Substring(0, 8)
$base = "http://localhost:4173/?db=$db"
$results = New-Object System.Collections.Generic.List[string]
$fail = 0
function Check([string]$name, [scriptblock]$block) {
  try { $r = & $block; if ($r -eq $false) { throw 'returned false' }; $script:results.Add("PASS  $name") }
  catch { $script:fail++; $script:results.Add("FAIL  $name`n      $($_.Exception.Message)") }
}
try {
  Start-CdpBrowser -ProfileDir $profileDir
  Invoke-Cdp 'Page.enable' | Out-Null
  Invoke-Cdp 'Page.addScriptToEvaluateOnNewDocument' @{ source = "window.__errors=[];addEventListener('error',e=>__errors.push(String(e.message||e.error)));addEventListener('unhandledrejection',e=>__errors.push('unhandled: '+(e.reason&&e.reason.message||e.reason)));" } | Out-Null
  Open-CdpUrl "$base#/dashboard"
  Wait-Js "document.body.dataset.ready === 'true'" 20 | Out-Null
  $helpers = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'ui-helpers.js'))
  Invoke-Js $helpers | Out-Null

  Check 'fresh database shows internal setup (1 client, 6 cost centres)' { Invoke-Js "(async()=>{await T.go('#/projects'); return T.rows()===6 && T.text().includes('Owners Salary');})()" }
  foreach ($r in 'dashboard','clients','contracts','clauses','projects','people','income','timeEntries','costs','recurring','salespeople','activities','payouts','acquisitions','sources','ledger','currencies','bank','reports','settings') {
    Check "navigation: $r renders without errors" { Invoke-Js "(async()=>{await T.go('#/$r'); const v=T.text(); return v.length>50 && !v.includes('could not be displayed') && window.__errors.length===0 ? true : 'ERR '+window.__errors.join('|');})()" | ForEach-Object { if ($_ -ne $true) { throw $_ } ; $true } }
  }
  Check 'Go to dropdown navigates' { Invoke-Js "(async()=>{const s=T.q('#goto'); s.value='costs'; s.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,200)); return location.hash==='#/costs' && T.text().includes('Project Costs');})()" }

  Check 'Cancel on a new client writes nothing' { Invoke-Js "(async()=>{await T.go('#/clients'); T.btn('Add client').click(); await T.wait(()=>T.dlg()); T.set('Client name','Cancelled Co'); T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await T.wait(()=>!document.querySelector('dialog')); const ds=await (await import('/js/ui/state.js')).app.db.loadAll(); return !ds.clients.some(c=>c.ClientName==='Cancelled Co');})()" }
  Check 'validation shown beside field (blank client name)' { Invoke-Js "(async()=>{T.btn('Add client').click(); await T.wait(()=>T.dlg()); T.btn('Submit',T.dlg()).click(); await new Promise(r=>setTimeout(r,100)); const err=T.dlg().querySelector('.field-error').textContent; T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,100)); return /required|Enter/.test(err);})()" }
  Check 'create client, project, employees, salesperson via forms' { Invoke-Js @"
(async()=>{
  await T.add('#/clients','Add client',[['Client name','Alpha Client']]);
  await T.add('#/projects','Add project',[['Client','Alpha Client'],['Project name','Website']]);
  await T.add('#/projects','Add project',[['Client','Alpha Client'],['Project name','Ads']]);
  await T.add('#/people','Add employee',[['Employee name','Ayesha'],['Monthly salary','320000'],['Join date','2099-01-01'],['Reference hours per month','160']]);
  await T.add('#/people','Add employee',[['Employee name','Bilal'],['Monthly salary','30,000'],['Join date','2099-01-01'],['Reference hours per month','80']]);
  await T.add('#/salespeople','Add sales profile',[['Employee','Bilal'],['Default close rate','5'],['Fee per attended meeting','2000']]);
  const ds=await (await import('/js/ui/state.js')).app.db.loadAll();
  const p=ds.projects.find(x=>x.ProjectName==='Website');
  return ds.clients.length===2 && p.ProjectType==='Client' && ds.people.length===2 && ds.salespeople[0].CloseRate===0.05 && ds.salespeople[0].MeetingFee==='2000.0000' && ds.people[1].MonthlyReferenceValue==='30000.0000';
})()
"@ }
  Check 'employee salary preview: join and leave months paid in full at month end' { Invoke-Js @"
(async()=>{
  await T.go('#/people'); T.btn('Add employee').click(); await T.wait(()=>T.dlg());
  T.set('Employee name','Preview Only'); T.set('Monthly salary','30000'); T.set('Join date','2026-09-23'); T.set('Leave date','2026-11-10'); T.set('Reference hours per month','80');
  const pv=T.dlg().querySelector('.preview').innerText;
  T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150));
  const ok=pv.includes('`$30,000.00 on 2026-09-30') && pv.includes('`$30,000.00 on 2026-11-30') && !pv.includes('days') && pv.includes('Team Salaries'); if(!ok) throw new Error(pv); return ok;
})()
"@ }
  Check 'time entry live preview then submit (2.5 h x 2,000 = 5,000)' { Invoke-Js @"
(async()=>{
  await T.go('#/timeEntries'); await T.go('#/timeEntries?new=1'); await T.wait(()=>T.dlg());
  T.set('Employee','Ayesha'); T.set('Project','Alpha Client / Website'); T.set('Hours worked','2.5');
  const pv=T.dlg().querySelector('.preview').innerText;
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg());
  return pv.includes('`$2,000.00') && pv.includes('`$5,000.00') && T.text().includes('`$5,000.00');
})()
"@ }
  Check 'HH:MM helper converts explicitly' { Invoke-Js "(async()=>{await T.go('#/timeEntries'); await T.go('#/timeEntries?new=1'); await T.wait(()=>T.dlg()); const hm=T.dlg().querySelector('.hhmm'); hm.value='1:30'; hm.nextElementSibling.click(); const v=T.field('Hours worked').value; T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150)); return v==='1.5';})()" }
  Check 'time tracker: manual mode adds 09:00-10:30 as 1.5 h; stopwatch saves elapsed time' { Invoke-Js @"
(async()=>{
  await T.go('#/timeEntries');
  const bar=()=>T.q('.tt-bar');
  const pick=async(name)=>{ bar().querySelector('.tt-project-btn').click(); await T.wait(()=>bar().querySelector('.tt-pop:not([hidden])')); const g=[...bar().querySelectorAll('.tt-pop-group')].find((x)=>x.innerText.toUpperCase().includes('ALPHA CLIENT')); [...g.querySelectorAll('.tt-pop-item')].find((b)=>b.textContent.trim()===name).click(); };
  bar().querySelector('[aria-label="Manual mode"]').click();
  const task=bar().querySelector('.tt-task'); task.value='Manual tracker task'; task.dispatchEvent(new Event('input'));
  await pick('Website');
  const setT=(l,v)=>{ const i=bar().querySelector('[aria-label="'+l+'"]'); i.value=v; i.dispatchEvent(new Event('change')); };
  setT('Start time','09:00'); setT('End time','10:30');
  const dur=bar().querySelector('.tt-duration').value;
  T.btn('Add',bar()).click();
  await T.wait(()=>T.text().includes('Manual tracker task'));
  const manualOk=dur==='01:30:00' && [...document.querySelectorAll('.te-row')].some((r)=>r.innerText.includes('Manual tracker task') && r.innerText.includes('1.50 h'));
  bar().querySelector('[aria-label="Timer mode"]').click();
  const t2=bar().querySelector('.tt-task'); t2.value='Stopwatch tracker task'; t2.dispatchEvent(new Event('input'));
  await pick('Website');
  T.btn('Start',bar()).click();
  const st=JSON.parse(localStorage.getItem('spt.timer')); st.startedAt=Date.now()-5400000; localStorage.setItem('spt.timer',JSON.stringify(st));
  await new Promise(r=>setTimeout(r,1800));
  T.btn('Stop',bar()).click();
  await T.wait(()=>T.text().includes('Stopwatch tracker task'));
  const timerOk=!localStorage.getItem('spt.timer') && [...document.querySelectorAll('.te-row')].some((r)=>r.innerText.includes('Stopwatch tracker task') && r.innerText.includes('1.50 h'));
  localStorage.removeItem('spt.timerMode');
  if(!(manualOk&&timerOk)) throw new Error('manual '+manualOk+' dur '+dur+' timer '+timerOk);
  return true;
})()
"@ }
  Check 'time tracker: similar entries grouped; resume starts timer with cost; cancel saves nothing' { Invoke-Js @"
(async()=>{
  await T.go('#/timeEntries');
  const bar=()=>T.q('.tt-bar');
  bar().querySelector('[aria-label="Manual mode"]').click();
  const task=bar().querySelector('.tt-task'); task.value='Manual tracker task'; task.dispatchEvent(new Event('input'));
  bar().querySelector('.tt-project-btn').click(); await T.wait(()=>bar().querySelector('.tt-pop:not([hidden])'));
  const g=[...bar().querySelectorAll('.tt-pop-group')].find((x)=>x.innerText.toUpperCase().includes('ALPHA CLIENT')); [...g.querySelectorAll('.tt-pop-item')].find((b)=>b.textContent.trim()==='Website').click();
  const setT=(l,v)=>{ const i=bar().querySelector('[aria-label="'+l+'"]'); i.value=v; i.dispatchEvent(new Event('change')); };
  setT('Start time','11:00'); setT('End time','11:30');
  T.btn('Add',bar()).click();
  await T.wait(()=>T.q('.te-group-row'));
  const grp=[...document.querySelectorAll('.te-group-row')].find((r)=>r.innerText.includes('Manual tracker task'));
  const grouped=!!grp && grp.querySelector('.te-count').textContent==='2' && grp.innerText.includes('2.00 h');
  const kidsHidden=[...document.querySelectorAll('.te-child')].every((k)=>k.hidden);
  grp.querySelector('.te-count').click(); const kidsShown=document.querySelectorAll('.te-child:not([hidden])').length===2;
  const before=document.querySelectorAll('.te-row:not(.te-group-row)').length;
  const row=[...document.querySelectorAll('.te-row:not(.te-group-row)')].find((r)=>r.innerText.includes('Stopwatch tracker task'));
  row.querySelector('.te-resume').click();
  await T.wait(()=>bar() && bar().querySelector('.tt-stop'));
  const st=JSON.parse(localStorage.getItem('spt.timer'));
  const resumed=st.task==='Stopwatch tracker task' && !!st.projectId && bar().querySelector('.tt-task').value==='Stopwatch tracker task' && bar().innerText.includes('Rough cost so far');
  T.btn('Cancel',bar()).click(); await T.wait(()=>T.btn('Cancel timer')); T.btn('Cancel timer').click();
  await T.wait(()=>!localStorage.getItem('spt.timer') && bar().querySelector('.tt-go:not(.tt-stop)'));
  const after=document.querySelectorAll('.te-row:not(.te-group-row)').length;
  const kpi=T.text().includes('AVERAGE PER WEEK') || T.text().toLowerCase().includes('average per week');
  localStorage.removeItem('spt.timerMode');
  if(!(grouped&&kidsHidden&&kidsShown&&resumed&&after===before&&kpi)) throw new Error(JSON.stringify({grouped,kidsHidden,kidsShown,resumed,before,after,kpi}));
  return true;
})()
"@ }
  Check 'income, cost and invalid EndDate rejected before Submit' { Invoke-Js @"
(async()=>{
  await T.add('#/income','Add income',[['Project','Alpha Client / Website'],['Start date','2026-01-10'],['Amount paid','100000']]);
  await T.go('#/costs'); T.btn('Add cost').click(); await T.wait(()=>T.dlg());
  T.set('Project / internal cost centre','Alpha Client / Website'); T.set('Start date','2026-02-01'); T.set('End date','2026-01-01'); T.set('Amount','10000');
  T.btn('Submit',T.dlg()).click(); await new Promise(r=>setTimeout(r,200));
  const err=T.dlg().innerText.includes('End date must be on or after');
  T.set('End date',''); T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg());
  return err;
})()
"@ }
  Check 'cost split equally across several projects' { Invoke-Js @"
(async()=>{
  await T.go('#/costs'); await new Promise(r=>setTimeout(r,150)); const before=document.querySelectorAll('#view .card > div > .table-wrap tbody tr:not(:has(td.empty))').length;
  T.btn('Add cost').click(); await T.wait(()=>T.dlg());
  T.set('Project / internal cost centre','Alpha Client / Website'); T.set('Start date','2026-02-02'); T.set('Cost item','Shared tool'); T.set('Amount','10001');
  const pick=T.field('Split equally'); const listedSelf=[...pick.options].some(o=>o.textContent==='Alpha Client / Website');
  T.set('Split equally','Alpha Client / Ads');
  const tags=[...T.dlg().querySelectorAll('.tag')].map(t=>t.firstChild.textContent.trim());
  const gone=![...T.field('Split equally').options].some(o=>o.textContent==='Alpha Client / Ads');
  const pv=T.dlg().querySelector('.preview').innerText;
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,200));
  const after=document.querySelectorAll('#view .card > div > .table-wrap tbody tr:not(:has(td.empty))').length;
  const t=T.text();
  return !listedSelf && gone && tags.join()==='Alpha Client / Ads' && pv.includes('`$5,000.50') && pv.includes('`$10,001.00') && after===before+2 && t.includes('Split equally across 2 projects') && (t.match(/\`$5,000\.50/g)||[]).length>=2;
})()
"@ }
  Check 'existing cost split when edited; tag can be removed' { Invoke-Js @"
(async()=>{
  const rowsSel='#view .card > div > .table-wrap tbody tr:not(:has(td.empty))';
  const before=document.querySelectorAll(rowsSel).length;
  const row=[...document.querySelectorAll(rowsSel)].find(r=>r.innerText.includes('`$10,000.00'));
  T.btn('Edit',row).click(); await T.wait(()=>T.dlg());
  T.set('Split equally','Alpha Client / Ads'); T.dlg().querySelector('.tag-remove').click();
  const removed=!T.dlg().querySelector('.tag');
  T.set('Split equally','Alpha Client / Ads');
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,200));
  const rows=[...document.querySelectorAll(rowsSel)];
  const halves=rows.filter(r=>r.innerText.includes('`$5,000.00') && r.innerText.includes('Split equally across 2 projects'));
  return removed && rows.length===before+1 && halves.length===2 && !rows.some(r=>r.cells[4].innerText.includes('`$10,000.00'));
})()
"@ }
  Check 'recurring cost can be split; field hidden for income' { Invoke-Js @"
(async()=>{
  await T.go('#/recurring'); T.btn('Add recurring').click(); await T.wait(()=>T.dlg());
  T.set('Project / internal cost centre','Alpha Client / Website'); T.set('Amount each time','3000');
  T.set('Split equally','Alpha Client / Ads');
  const pv=T.dlg().querySelector('.preview').innerText;
  const visible=!T.field('Split equally').closest('.field').hidden;
  T.set('Type','Income'); const hidden=T.field('Split equally').closest('.field').hidden;
  T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150));
  return visible && hidden && pv.includes('split across 2 projects') && (pv.match(/\`$1,500\.00/g)||[]).length===2;
})()
"@ }
  Check 'contract with clauses; end date from term; project hidden when all clauses ended, back when renewed' { Invoke-Js @"
(async()=>{
  await T.add('#/clients','Add client',[['Client name','Beta Co']]);
  await T.add('#/projects','Add project',[['Client','Beta Co'],['Project name','Beta Site']]);
  await T.add('#/contracts','Add contract',[['Client','Beta Co'],['Contract name (optional)','Hosting 2025'],['Projects covered','Beta Co / Beta Site']]);
  let row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('Hosting 2025'));
  const noClauses=row.innerText.includes('No clauses');
  T.btn('Clauses (0)',row).click(); await new Promise(r=>setTimeout(r,200));
  const filtered=location.hash.includes('contract=');
  T.btn('Add clause').click(); await T.wait(()=>T.dlg());
  const pre=T.field('Contract').selectedOptions[0].textContent;
  T.set('Clause','Hosting'); T.set('Start date','2024-01-01'); T.set('Term: years','1');
  const endShown=T.field('End date (calculated)').value;
  T.set('Renewal notice period','4'); T.set('Notice unit','week'); T.set('Agreed charge to client (reference)','60000'); T.set('Expected cost to Engineered Plans (reference)','20000');
  const pv=T.dlg().querySelector('.preview').innerText;
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,150));
  await T.add('#/clauses','Add clause',[['Contract','Beta Co / Hosting 2025'],['Clause','SSL'],['Start date','2024-01-01'],['Term: months','6'],['Agreed charge to client (reference)','5000'],['Expected cost to Engineered Plans (reference)','1000']]);
  const crow=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('SSL')).innerText;
  const clauseRow=crow.includes('2024-07-01') && crow.includes('6 months') && crow.includes('Ended');
  // reopening a clause shows its end date and is not an unsaved change
  T.btn('Edit',[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('SSL'))).click(); await T.wait(()=>T.dlg());
  const reopened=T.field('End date (calculated)').value;
  T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150)); const notDirty=!T.btn('Discard changes') && !T.dlg();
  await T.go('#/contracts'); row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('Hosting 2025')).innerText;
  const totals=row.includes('Ended') && row.includes('Clauses (2)') && !row.includes('65,000'); // figures come from the project's income and costs, not the clause amounts
  await T.go('#/projects'); const hiddenList=!T.text().includes('Beta Site');
  const cb=[...document.querySelectorAll('.filter-check input')][0]; cb.checked=true; cb.dispatchEvent(new Event('change')); await new Promise(r=>setTimeout(r,100));
  const shown=[...document.querySelectorAll('#view tbody tr')].some(r=>r.innerText.includes('Beta Site') && r.innerText.includes('contract ended'));
  cb.checked=false; cb.dispatchEvent(new Event('change'));
  await T.go('#/income'); T.btn('Add income').click(); await T.wait(()=>T.dlg());
  const inSelector=[...T.field('Project').options].some(o=>o.textContent.startsWith('Beta Co / Beta Site'));
  T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150)); if(T.btn('Discard changes')) { T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150)); }
  // one active clause makes the contract active again
  await T.add('#/clauses','Add clause',[['Contract','Beta Co / Hosting 2025'],['Clause','Hosting renewal'],['Start date','2025-01-02'],['Term: years','5']]);
  await T.go('#/projects'); const back=T.text().includes('Beta Site');
  await T.go('#/contracts'); const active=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('Hosting 2025')).innerText.includes('Active');
  if (noClauses && filtered && pre.includes('Hosting 2025') && endShown==='2025-01-01' && pv.includes('2024-12-04') && clauseRow && reopened==='2024-07-01' && notDirty && totals && hiddenList && shown && !inSelector && back && active) return true;
  throw new Error(JSON.stringify({noClauses,filtered,pre,endShown,pv,clauseRow,crow,reopened,notDirty,totals,row,hiddenList,shown,inSelector,back,active}));
})()
"@ }
  Check 'client company details: shown on Clients and as "name - company" elsewhere' { Invoke-Js @"
(async()=>{
  await T.go('#/clients'); T.btn('Edit',[...document.querySelectorAll('#view tbody tr')].find(r=>r.cells[0].innerText.trim()==='Beta Co')).click(); await T.wait(()=>T.dlg());
  T.set('Company name','Beta Holdings'); T.set('Website','beta.example'); T.set('Phone number','+92 300 1234567'); T.set('Email','not-an-email');
  T.btn('Submit',T.dlg()).click(); await new Promise(r=>setTimeout(r,150)); const emailErr=T.dlg() && T.dlg().innerText.includes('valid email');
  T.set('Email','ops@beta.example'); T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,150));
  const row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.cells[0].innerText.trim()==='Beta Co');
  const link=row.querySelector('a[href="https://beta.example"]') && row.querySelector('a[href="mailto:ops@beta.example"]') && row.querySelector('a[href="tel:+923001234567"]');
  await T.go('#/contracts'); const inContracts=T.text().includes('Beta Co - Beta Holdings');
  await T.go('#/income'); T.btn('Add income').click(); await T.wait(()=>T.dlg());
  const inSelector=[...T.field('Project').options].some(o=>o.textContent.startsWith('Beta Co - Beta Holdings / '));
  T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150)); if(T.btn('Discard changes')) { T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150)); }
  if (emailErr && link && inContracts && inSelector) return true;
  throw new Error(JSON.stringify({emailErr,link:!!link,inContracts,inSelector}));
})()
"@ }
  Check 'contract renewals highlighted: yellow within a month, red within a week' { Invoke-Js @"
(async()=>{
  const { addDays } = await import('/js/lib/dates.js'); const { addMonthsClamped } = await import('/js/calc/recurring.js');
  const today = new Date(Date.now() - new Date().getTimezoneOffset()*60000).toISOString().slice(0,10);
  const start = (daysLeft) => addMonthsClamped(addDays(today, daysLeft), -12);
  await T.add('#/clauses','Add clause',[['Contract','Beta Co - Beta Holdings / Hosting 2025'],['Clause','Domain'],['Start date',start(10)],['Term: years','1']]);
  const rowOf = (txt) => [...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes(txt));
  const soon = rowOf('Domain').classList.contains('row-renew-soon') && rowOf('Domain').innerText.includes('approval in 10 days');
  const yellow = getComputedStyle(rowOf('Domain').cells[1]).backgroundColor;
  await T.go('#/contracts'); const cSoon = rowOf('Hosting 2025').classList.contains('row-renew-soon');
  await T.add('#/clauses','Add clause',[['Contract','Beta Co - Beta Holdings / Hosting 2025'],['Clause','SSL renewal'],['Start date',start(3)],['Term: years','1']]);
  const urgent = rowOf('SSL renewal').classList.contains('row-renew-urgent');
  const red = getComputedStyle(rowOf('SSL renewal').cells[1]).backgroundColor;
  await T.go('#/contracts'); const cUrgent = rowOf('Hosting 2025').classList.contains('row-renew-urgent') && rowOf('Hosting 2025').innerText.includes('in 3 days');
  if (soon && cSoon && urgent && cUrgent && yellow==='rgb(255, 243, 196)' && red==='rgb(253, 220, 216)') return true;
  throw new Error(JSON.stringify({soon,cSoon,urgent,cUrgent,yellow,red}));
})()
"@ }
  Check 'notification bell: renewal + recurring-added notices with date/time, mark read, open' { Invoke-Js @"
(async()=>{
  await T.add('#/recurring','Add recurring',[['Task / name','Bell test'],['Project / internal cost centre','Alpha Client / Website'],['Amount each time','100']]);
  const bell=document.getElementById('notif-bell'), badge=bell.querySelector('.notif-badge');
  await T.wait(()=>{ bell.click(); const ok=[...document.querySelectorAll('.notif-title')].some(t=>t.textContent.includes('Bell test')); if(!ok) bell.click(); return ok; }, 6000);
  const titles=[...document.querySelectorAll('.notif-title')].map(t=>t.textContent);
  const hasRenewal=titles.some(t=>t==='Renewal approval due within 2 weeks');
  const hasRecurring=titles.includes('Recurring cost added: Bell test');
  const time=document.querySelector('.notif-item time'); const stamped=!!time && !isNaN(new Date(time.getAttribute('datetime'))) && /\d{1,2}:\d{2}/.test(time.textContent);
  const unreadBefore=Number(badge.textContent);
  T.btn('Mark all read',document.getElementById('notif-panel')).click(); await T.wait(()=>badge.hidden);
  const item=[...document.querySelectorAll('.notif-item')].find(li=>li.innerText.includes('Bell test'));
  item.querySelector('.notif-open').click(); await new Promise(r=>setTimeout(r,250));
  const navigated=location.hash==='#/costs' && document.getElementById('notif-panel').hidden;
  const stored=(await (await import('/js/ui/state.js')).app.db.getMeta('notifications')).filter(n=>n.key.startsWith('recurring-created:')).length;
  if (hasRenewal && hasRecurring && stamped && unreadBefore>=2 && navigated && stored>=1) return true;
  throw new Error(JSON.stringify({titles,hasRenewal,hasRecurring,stamped,unreadBefore,navigated,stored}));
})()
"@ }
  Check 'Settings: send a test notification' { Invoke-Js @"
(async()=>{
  await T.go('#/settings'); T.btn('Send a test notification').click();
  const badge=document.querySelector('#notif-bell .notif-badge');
  await T.wait(()=>!badge.hidden && badge.textContent==='1');
  document.getElementById('notif-bell').click(); await new Promise(r=>setTimeout(r,100));
  const li=document.querySelector('.notif-item'); const ok=li.innerText.includes('Test notification') && li.innerText.includes('TEST') && li.classList.contains('unread');
  document.body.click(); return ok;
})()
"@ }
  Check 'sales meeting + payout overpayment confirm; balance shown' { Invoke-Js @"
(async()=>{
  await T.go('#/activities'); T.btn('Add activity').click(); await T.wait(()=>T.dlg());
  T.set('Activity type','Attended meeting'); T.set('Project','Alpha Client / Ads'); T.set('Salesperson','Bilal');
  const pv=T.dlg().querySelector('.preview').innerText; T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg());
  await T.go('#/payouts'); T.btn('Record payout').click(); await T.wait(()=>T.dlg());
  T.set('Salesperson','Bilal'); T.set('Amount paid','1500'); const bal=T.dlg().querySelector('.preview').innerText;
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg());
  T.btn('Record payout').click(); await T.wait(()=>T.dlg()); T.set('Salesperson','Bilal'); T.set('Amount paid','5000'); T.btn('Submit',T.dlg()).click();
  await T.wait(()=>T.btn('Record overpayment')); const warned=true; T.btn('Go back').click(); await new Promise(r=>setTimeout(r,150));
  T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150));
  const { app } = await import('/js/ui/state.js'); const { salesSummary } = await import('/js/calc/calc.js');
  const s=salesSummary(app.idx)[0];
  return pv.includes('`$2,000.00') && bal.includes('`$2,000.00') && warned && s.owed.toString()==='500' && app.ds.payouts.length===1;
})()
"@ }
  Check 'client acquisition: rate prefilled, internal client not offered, stop date' { Invoke-Js @"
(async()=>{
  await T.go('#/acquisitions'); T.btn('Add acquisition').click(); await T.wait(()=>T.dlg());
  const opts=[...T.field('Client').options].map(o=>o.textContent);
  T.set('Client','Alpha Client'); T.set('Acquiring salesperson','Bilal'); const rate=T.field('Acquisition commission rate').value;
  T.set('Acquisition date','2026-01-01'); T.set('Acquisition commission rate','10'); const pv=T.dlg().querySelector('.preview').innerText;
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg());
  return !opts.some(o=>o.includes('internal')) && rate==='5' && pv.includes('2026-06-30') && pv.includes('`$10,000.00') && T.text().includes('`$10,000.00');
})()
"@ }
  Check 'client form: acquisition source + salesperson acquisition created, shown, then removed' { Invoke-Js @"
(async()=>{
  await T.add('#/sources','Add source',[['Source name','Fiverr']]);
  const editBeta=async()=>{ await T.go('#/clients'); T.btn('Edit',[...document.querySelectorAll('#view tbody tr')].find(r=>r.cells[0].innerText.trim()==='Beta Co')).click(); await T.wait(()=>T.dlg()); };
  await editBeta();
  T.set('Acquisition source','Fiverr'); T.set('Acquired by salesperson','Bilal');
  const prefilled=T.field('Acquisition commission rate').value==='5' && !!T.field('Acquisition date').value;
  T.set('Acquisition date','2026-02-01');
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,300));
  const row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.cells[0].innerText.trim()==='Beta Co');
  const rowText=row.innerText; const shown=rowText.includes('Fiverr') && rowText.includes('Acquired') && rowText.includes('Bilal');
  const acqRows=()=>[...document.querySelectorAll('#view tbody tr')].filter(r=>r.innerText.includes('Beta Co'));
  await T.go('#/acquisitions'); const created=acqRows().some(r=>r.innerText.includes('2026-02-01'));
  await editBeta();
  const loaded=T.field('Acquired by salesperson').selectedOptions[0].textContent.startsWith('Bilal') && T.field('Acquisition date').value==='2026-02-01';
  T.set('Acquired by salesperson','');
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>T.btn('Remove acquisition')); T.btn('Remove acquisition').click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,150));
  await T.go('#/acquisitions'); const removed=acqRows().length===0;
  await T.go('#/sources'); const listed=[...document.querySelectorAll('#view tbody tr')].some(r=>r.innerText.includes('Fiverr') && r.innerText.includes('Beta Co'));
  if(!(prefilled&&shown&&created&&loaded&&removed&&listed)) throw new Error(JSON.stringify({prefilled,shown,created,loaded,removed,listed}));
  return true;
})()
"@ }
  Check 'delete blocked by dependencies; archive offered' { Invoke-Js "(async()=>{await T.go('#/clients'); const row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('Alpha Client')); row.querySelector('.btn-danger-ghost').click(); await T.wait(()=>T.btn('Archive instead')); const ok=T.dlg().innerText.includes('cannot be deleted'); T.btn('Close',T.dlg()).click(); await new Promise(r=>setTimeout(r,100)); return ok;})()" }
  Check 'delete with record-specific confirmation (payout)' { Invoke-Js "(async()=>{await T.go('#/payouts'); document.querySelector('#view .btn-danger-ghost').click(); await T.wait(()=>T.dlg()); const t=T.dlg().innerText; T.btn('Delete',T.dlg()).click(); await new Promise(r=>setTimeout(r,300)); const { app } = await import('/js/ui/state.js'); return t.includes('payout #1') && app.ds.payouts.length===0;})()" }
  Check 'unsaved form blocks navigation (Stay here keeps the form)' { Invoke-Js "(async()=>{await T.go('#/clients'); T.btn('Add client').click(); await T.wait(()=>T.dlg()); T.set('Client name','Dirty'); location.hash='#/projects'; await T.wait(()=>T.btn('Stay here')); T.btn('Stay here').click(); await new Promise(r=>setTimeout(r,150)); const still=!!T.dlg() && location.hash==='#/clients'; T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,150)); return still;})()" }
  Check 'bank details: cancel restores, switching blocked while dirty, submit persists, holder name independent' { Invoke-Js @"
(async()=>{
  await T.go('#/bank'); const sel=T.q('#bank-employee'); const names=[...sel.options].map(o=>o.textContent);
  T.set('Bank name','Test Bank'); T.set('Account holder name','A. HOLDER'); T.set('IBAN / account number','PK00 TEST  0001');
  const other=[...sel.options].find(o=>o.value!==sel.value).value; const before=sel.value; sel.value=other; sel.dispatchEvent(new Event('change'));
  const blocked=sel.value===before && T.text().includes('Press Submit or Cancel');
  T.btn('Cancel').click(); await new Promise(r=>setTimeout(r,300));
  const cleared=T.field('Bank name').value==='';
  T.set('Bank name','Test Bank'); T.set('Account holder name','A. HOLDER'); T.set('IBAN / account number','PK00 TEST  0001');
  T.btn('Submit').click(); await new Promise(r=>setTimeout(r,400));
  const { app } = await import('/js/ui/state.js'); const p=app.ds.people.find(x=>String(x.PersonID)===before);
  return names.join()==='Ayesha,Bilal' && blocked && cleared && p.AccountName==='A. HOLDER' && p.IBAN==='PK00 TEST  0001' && p.PersonName==='Ayesha';
})()
"@ }
  Check 'reports: all views render; bank report includes blanks; company totals' { Invoke-Js @"
(async()=>{
  const { REPORTS } = await import('/js/reports/reports.js');
  for (const r of REPORTS) { await T.go('#/reports/'+r.id); if (!T.text().includes(r.title) || window.__errors.length) return 'fail '+r.id+' '+window.__errors.join('|'); }
  await T.go('#/reports/bank-details'); const b=T.text();
  await T.go('#/reports/company-totals'); const c=T.text();
  return b.includes('Not recorded') && b.includes('PK00 TEST  0001'.replace('  ',' ')) || b.includes('PK00 TEST') ? (c.includes('Net After Owner Salary') ? true : 'company') : 'bank';
})()
"@ | ForEach-Object { if ($_ -ne $true) { throw "$_" }; $true } }
  Check 'cross-tab change notification refreshes views' { Invoke-Js @"
(async()=>{
  await T.go('#/clients'); const { app } = await import('/js/ui/state.js'); const { TrackerDB } = await import('/js/storage/db.js');
  const other = await TrackerDB.open(app.dbName); await other.create('clients',{ClientName:'From Other Tab',IsInternal:false}); other.close();
  await T.wait(()=>T.text().includes('From Other Tab'), 4000); return true;
})()
"@ }
  Check 'stale edit is refused, not silently overwritten' { Invoke-Js @"
(async()=>{
  await T.go('#/clients'); const row=[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('From Other Tab')); row.querySelector('.btn').click(); await T.wait(()=>T.dlg());
  const { app } = await import('/js/ui/state.js'); const { TrackerDB } = await import('/js/storage/db.js');
  const other = await TrackerDB.open(app.dbName); const rec=(await other.loadAll()).clients.find(c=>c.ClientName==='From Other Tab'); await other.update('clients',{...rec,ClientName:'Renamed Elsewhere'},rec.revision); other.close();
  await new Promise(r=>setTimeout(r,400)); T.set('Client name','My Edit'); T.btn('Submit',T.dlg()).click(); await new Promise(r=>setTimeout(r,400));
  const msg=T.dlg().innerText; T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click(); await new Promise(r=>setTimeout(r,300));
  const ds=await app.db.loadAll(); return msg.includes('changed in another tab') && ds.clients.some(c=>c.ClientName==='Renamed Elsewhere');
})()
"@ }
  Check 'currencies: USD income at its date rate, future date provisional, actual rate on a cost, Currencies page' { Invoke-Js @"
(async()=>{
  const { app } = await import('/js/ui/state.js');
  const fx = await import('/js/calc/fx.js');
  const { todayISO, addDays } = await import('/js/lib/dates.js');
  const today = todayISO();
  const seed = async (date, cad) => { const d = { date, rates: { usd: 1, cad, aed: 3.6725, pkr: 280 }, fetchedAt: new Date().toISOString() }; await app.db.putFxDay(d); fx.setLatestDay(d); };
  await seed('2026-10-01', 277.00876191); await seed(today, 280);
  const addIncome = async (date, amount, extra=[]) => {
    await T.go('#/income'); await T.go('#/income?new=1'); await T.wait(()=>T.dlg());
    T.set('Project','Alpha Client / Website'); T.set('Start date',date); T.set('Currency','USD');
    T.set('Amount paid (in that currency)',amount); for (const [k,v] of extra) T.set(k,v);
    await T.wait(()=>T.dlg().querySelector('.preview').innerText.includes('CAD$ ('));
    const pv=T.dlg().querySelector('.preview').innerText;
    T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,200));
    return pv;
  };
  const pv1 = await addIncome('2026-10-01','100');
  const row = [...document.querySelectorAll('#view tbody tr')].find((r)=>r.innerText.includes('USD 100.00'));
  const finalOk = pv1.includes('277.0088') && !!row && row.innerText.includes('27,700.88') && !row.innerText.includes('provisional');
  const future = addDays(today, 7);
  await addIncome(future,'10');
  const frow = [...document.querySelectorAll('#view tbody tr')].find((r)=>r.innerText.includes('USD 10.00'));
  const provOk = !!frow && frow.innerText.includes('provisional') && frow.innerText.includes('2,800.00');
  await T.go('#/costs'); await T.go('#/costs?new=1'); await T.wait(()=>T.dlg());
  T.set('Project / internal cost centre','Alpha Client / Website'); T.set('Start date','2026-10-01'); T.set('Currency','AED');
  T.set('Amount (in that currency)','50'); T.set('Actual rate received','76');
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,200));
  const crow = [...document.querySelectorAll('#view tbody tr')].find((r)=>r.innerText.includes('AED 50.00'));
  const manualOk = !!crow && crow.innerText.includes('3,800.00') && crow.innerText.includes('actual rate');
  await T.go('#/currencies');
  const page = T.text();
  const pageOk = page.includes('USD') && page.includes('280.0000') && page.includes('Waiting for the final rate') && page.includes(future);
  if(!(finalOk&&provOk&&manualOk&&pageOk)) throw new Error(JSON.stringify({finalOk,provOk,manualOk,pageOk,pv1}));
  return true;
})()
"@ }
  Check 'attachments: receipt on a new cost, paperclip in the list, delete note; invoices on income; none on recurring rules' { Invoke-Js @"
(async()=>{
  const attach=(name)=>{ const dt=new DataTransfer(); dt.items.add(new File(['%PDF-1.4 test'], name, { type: 'application/pdf' })); const i=T.dlg().querySelector('.att-box input[type=file]'); i.files=dt.files; i.dispatchEvent(new Event('change')); };
  await T.go('#/costs'); await T.go('#/costs?new=1'); await T.wait(()=>T.dlg());
  const costTitle=T.dlg().querySelector('.att-box h3').textContent;
  T.set('Project / internal cost centre','Alpha Client / Website'); T.set('Start date','2026-03-03'); T.set('Cost item / salary description','Receipt test'); T.set('Amount','1234');
  attach('receipt-test.pdf');
  const staged=T.dlg().innerText.includes('receipt-test.pdf') && T.dlg().innerText.includes('added on Submit');
  T.btn('Submit',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,250));
  const row=()=>[...document.querySelectorAll('#view tbody tr')].find((r)=>r.innerText.includes('Receipt test'));
  const clip=!!row() && !!row().querySelector('.att-count') && row().querySelector('.att-count').textContent.trim()==='1';
  T.btn('Edit',row()).click(); await T.wait(()=>T.dlg());
  const shown=T.dlg().innerText.includes('receipt-test.pdf') && !T.dlg().innerText.includes('added on Submit');
  T.btn('Cancel',T.dlg()).click(); await T.wait(()=>!T.dlg());
  row().querySelector('.btn-danger-ghost').click(); await T.wait(()=>T.dlg());
  const note=T.dlg().innerText.includes('Its receipt is deleted too');
  T.btn('Delete',T.dlg()).click(); await T.wait(()=>!T.dlg()); await new Promise(r=>setTimeout(r,250));
  const gone=!row();
  await T.go('#/income'); await T.go('#/income?new=1'); await T.wait(()=>T.dlg());
  const incTitle=T.dlg().querySelector('.att-box h3').textContent;
  T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150));
  await T.go('#/recurring'); await T.go('#/recurring?new=1'); await T.wait(()=>T.dlg());
  const noneOnRules=!T.dlg().querySelector('.att-box');
  T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150));
  const ok=costTitle==='Receipts'&&staged&&clip&&shown&&note&&gone&&incTitle==='Invoices'&&noneOnRules;
  if(!ok) throw new Error(JSON.stringify({costTitle,staged,clip,shown,note,gone,incTitle,noneOnRules}));
  return true;
})()
"@ }
  Check 'no script errors during run' { Invoke-Js "window.__errors.length===0 ? true : window.__errors.join(' | ')" | ForEach-Object { if ($_ -ne $true) { throw "$_" }; $true } }

  # Screenshots and print previews of primary reports
  Invoke-Js "T.go('#/dashboard')" | Out-Null; Start-Sleep -Milliseconds 400
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-dashboard.png') 1366 900
  Invoke-Js "T.go('#/timeEntries')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-time.png') 1366 900
  Invoke-Js "(async()=>{await T.go('#/costs'); await T.go('#/costs?new=1'); await T.wait(()=>T.dlg()); const dt=new DataTransfer(); dt.items.add(new File(['x'], 'Hosting invoice Oct.pdf', { type: 'application/pdf' })); dt.items.add(new File(['y'], 'card-slip.jpg', { type: 'image/jpeg' })); const i=T.dlg().querySelector('.att-box input[type=file]'); i.files=dt.files; i.dispatchEvent(new Event('change')); T.dlg().querySelector('.att-box').scrollIntoView();})()" | Out-Null; Start-Sleep -Milliseconds 400
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-cost-receipts.png') 1366 900
  Invoke-Js "(async()=>{T.btn('Cancel',T.dlg()).click(); await T.wait(()=>T.btn('Discard changes')); T.btn('Discard changes').click();})()" | Out-Null; Start-Sleep -Milliseconds 300
  Invoke-Js "T.go('#/currencies')" | Out-Null; Start-Sleep -Milliseconds 600
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-currencies.png') 1366 900
  Invoke-Js "T.go('#/income')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-income.png') 1366 900
  Invoke-Js "T.go('#/settings')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-settings.png') 1366 900
  Invoke-Js "(async()=>{await T.go('#/dashboard'); document.getElementById('notif-bell').click();})()" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-notifications.png') 1366 900
  Save-CdpScreenshot (Join-Path $OutDir 'mobile-notifications.png') 390 844 -Mobile
  Invoke-Js "document.body.click()" | Out-Null
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-dashboard-2.png') 1366 900
  Invoke-Js "T.go('#/contracts')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-contracts.png') 1366 900
  Invoke-Js "T.go('#/clauses')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-clauses.png') 1366 900
  Invoke-Js "(async()=>{await T.go('#/clauses'); T.btn('Add clause').click();})()" | Out-Null; Start-Sleep -Milliseconds 400
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-clause-form.png') 1366 900
  Invoke-Js "(async()=>{T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150));})()" | Out-Null
  Invoke-Js "(async()=>{await T.go('#/contracts'); T.btn('Edit',[...document.querySelectorAll('#view tbody tr')].find(r=>r.innerText.includes('Hosting 2025'))).click();})()" | Out-Null; Start-Sleep -Milliseconds 400
  Save-CdpScreenshot (Join-Path $OutDir 'desktop-contract-form.png') 1366 900
  Invoke-Js "(async()=>{T.btn('Cancel',T.dlg()).click(); await new Promise(r=>setTimeout(r,150));})()" | Out-Null
  foreach ($rep in @(@('project-lifetime', $true), @('company-totals', $false), @('sales-team', $true), @('acquisition-commissions', $true), @('bank-details', $false))) {
    Invoke-Js "T.go('#/reports/$($rep[0])')" | Out-Null; Start-Sleep -Milliseconds 400
    Save-CdpPdf (Join-Path $OutDir "print-$($rep[0]).pdf") $rep[1]
  }
  Invoke-Js "T.go('#/reports/project-lifetime')" | Out-Null
  Save-CdpScreenshot (Join-Path $OutDir 'mobile-report.png') 390 844 -Mobile
  Invoke-Js "T.go('#/bank')" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'mobile-bank.png') 390 844 -Mobile
  Check 'mobile: no horizontal page overflow (tables scroll inside their container)' { Invoke-Js "(async()=>{for (const r of ['#/dashboard','#/income','#/reports/project-lifetime','#/bank','#/settings']) { await T.go(r); await new Promise(x=>setTimeout(x,150)); if (document.documentElement.scrollWidth > innerWidth + 1) return 'overflow at '+r+' '+document.documentElement.scrollWidth; } return true;})()" | ForEach-Object { if ($_ -ne $true) { throw "$_" }; $true } }
  Invoke-Js "T.go('#/income')" | Out-Null; Start-Sleep -Milliseconds 200
  Invoke-Js "T.btn('Add income').click()" | Out-Null; Start-Sleep -Milliseconds 300
  Save-CdpScreenshot (Join-Path $OutDir 'mobile-form.png') 390 844 -Mobile
} finally {
  $results -join "`n"
  "`n$($results.Count - $fail) passed, $fail failed. Output: $OutDir"
  try { Invoke-Js "indexedDB.deleteDatabase('$db')" | Out-Null } catch {}
  Stop-CdpBrowser
  if ($started) { & "$Root\launcher\stop.ps1" | Out-Null }
  Remove-Item -Recurse -Force $profileDir -ErrorAction SilentlyContinue
}
