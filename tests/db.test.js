import { test, assert, eq, rejects } from './harness.js';
import { TrackerDB } from '../js/storage/db.js';
import { buildBackup, backupJSON, parseBackup, restoreParsed } from '../js/io/backup.js';
import { missingOccurrences } from '../js/calc/recurring.js';
import { parseAccessExport, importParsed } from '../js/io/accessImport.js';
import { demoDataset, seedStarterData, resetDataset } from '../js/io/fixtures.js';
import { buildIndex, companyTotals, projectRows, sumBuckets, aggregate, salesSummary } from '../js/calc/calc.js';
import { Dec } from '../js/lib/decimal.js';
import { STORES } from '../js/model/schema.js';
import { validateDataset } from '../js/model/validate.js';

// Isolated test databases only; never the live database.
const opened = [];
export async function freshDB() {
  const name = 'engineeredplans_test_' + Math.random().toString(36).slice(2);
  const db = await TrackerDB.open(name);
  opened.push(db);
  return db;
}
export async function cleanupTestDBs() {
  for (const db of opened) {
    if (!db.name.startsWith('engineeredplans_test_')) throw new Error('refusing to delete a non-test database');
    db.close();
    await new Promise((res) => { const r = indexedDB.deleteDatabase(db.name); r.onsuccess = r.onerror = r.onblocked = () => res(); });
  }
}

test('db: fresh database seeds internal client + six cost centres exactly once', async () => {
  const db = await freshDB();
  let ds = await db.loadAll();
  eq(ds.clients.length, 1); eq(ds.projects.length, 6);
  assert(ds.clients[0].IsInternal && ds.projects.every((p) => p.CategoryCode && p.ProjectType === 'Internal'));
  db.close();
  const again = await TrackerDB.open(db.name); opened.push(again);
  ds = await again.loadAll();
  eq(ds.clients.length, 1, 'no reseed on reopen'); eq(ds.projects.length, 6);
});

test('db: starter sample data is added once to an empty database, never over existing records; reset restores the setup', async () => {
  const db = await freshDB();
  eq(await seedStarterData(db), true);
  let ds = await db.loadAll();
  eq(ds.clients.length, 3); eq(ds.projects.length, 8);
  eq(await seedStarterData(db), false, 'only once');
  eq((await db.loadAll()).clients.length, 3);
  const busy = await freshDB();
  await busy.create('clients', { ClientName: 'Real client', IsInternal: false });
  eq(await seedStarterData(busy), false, 'existing records are left alone');
  eq((await busy.loadAll()).clients.length, 2);
  await db.replaceAll(resetDataset());
  ds = await db.loadAll();
  eq(ds.clients.length, 1); eq(ds.projects.length, 6);
  eq((await db.create('clients', { ClientName: 'After reset', IsInternal: false })).ClientID, 2, 'IDs restart after a reset');
  await db.replaceAll(resetDataset({ sample: true }));
  eq((await db.loadAll()).projects.length, 8);
});

test('db: create/update/delete with revisions, FK enforcement and dependency protection', async () => {
  const db = await freshDB();
  const c = await db.create('clients', { ClientName: 'Alpha', IsInternal: false });
  eq(c.ClientID, 2); eq(c.revision, 1);
  const p = await db.create('projects', { ClientID: c.ClientID, ProjectName: 'Web', ProjectType: 'Client' });
  await rejects(db.create('projects', { ClientID: 999, ProjectName: 'Bad', ProjectType: 'Client' }), /ValidationError/, 'missing FK');
  await rejects(db.create('income', { ProjectID: p.ProjectID, StartDate: '2026-02-30', AmountPaid: '1.0000' }), /ValidationError/, 'invalid date');
  const inc = await db.create('income', { ProjectID: p.ProjectID, StartDate: '2026-01-01', AmountPaid: '118481.8780' });
  const u = await db.update('clients', { ...c, ClientName: 'Alpha Ltd' }, 1);
  eq(u.revision, 2);
  await rejects(db.update('clients', { ...c, ClientName: 'Stale' }, 1), /StaleError/, 'stale edit rejected');
  const err = await rejects(db.remove('projects', p.ProjectID, p.revision), /DependencyError/);
  eq(err.deps[0].store, 'income');
  await db.remove('income', inc.IncomeID, 1);
  await db.remove('projects', p.ProjectID, 1);
  const inc2 = await db.create('income', { ProjectID: 1, StartDate: '2026-01-01', AmountPaid: '5.0000' });
  eq(inc2.IncomeID, 2, 'IDs are not reused after deletion');
  const ds = await db.loadAll();
  eq(ds.clients.find((x) => x.ClientID === 2).ClientName, 'Alpha Ltd');
  eq(ds.income[0].AmountPaid, '5.0000');
});

test('db: salesperson profile duplicate and acquisition uniqueness enforced in transaction', async () => {
  const db = await freshDB();
  const person = await db.create('people', { PersonName: 'S', MonthlyReferenceValue: '0.0000', ReferenceHours: 160, JoinDate: '2026-01-01' });
  const sp = await db.create('salespeople', { PersonID: person.PersonID, CloseRate: 0.05, MeetingFee: '0.0000' });
  await rejects(db.create('salespeople', { PersonID: person.PersonID, CloseRate: 0.05, MeetingFee: '0.0000' }), /already has a sales profile/);
  const c = await db.create('clients', { ClientName: 'A', IsInternal: false });
  await db.create('acquisitions', { ClientID: c.ClientID, SalespersonID: sp.SalespersonID, AcquisitionDate: '2026-01-01', AcquisitionRate: 0.1 });
  await rejects(db.create('acquisitions', { ClientID: c.ClientID, SalespersonID: sp.SalespersonID, AcquisitionDate: '2026-01-01', AcquisitionRate: 0.1 }), /already has an acquisition/);
  await rejects(db.create('acquisitions', { ClientID: 1, SalespersonID: sp.SalespersonID, AcquisitionDate: '2026-01-01', AcquisitionRate: 0.1 }), /internal/);
});

test('J11 bank details: account holder independent of employee name; blanks preserved; revision on submit', async () => {
  const db = await freshDB();
  const p = await db.create('people', { PersonName: 'Aisha', MonthlyReferenceValue: '30000.0000', ReferenceHours: 80, JoinDate: '2026-01-01' });
  assert(p.BankName === null && p.IBAN === null, 'bank details optional');
  const u = await db.update('people', { ...p, BankName: 'Test Bank', AccountName: 'A. HOLDER  NAME', IBAN: 'PK00 TEST  0000 0001' }, 1);
  const ds = await db.loadAll();
  const r = ds.people[0];
  eq(r.PersonName, 'Aisha'); eq(r.AccountName, 'A. HOLDER  NAME'); eq(r.IBAN, 'PK00 TEST  0000 0001'); eq(u.revision, 2);
});

test('J12/J13 backup round-trip is exact; restore validation failures leave data intact', async () => {
  const db = await freshDB();
  await restoreParsed(db, { ok: true, data: { stores: demoDataset(), nextIds: {}, settings: { logo: { dataUrl: 'data:image/png;base64,iVBORw0KGgo=', name: 'x.png' } } } });
  const b1 = await buildBackup(db);
  const text = backupJSON(b1);
  const parsed = parseBackup(text);
  assert(parsed.ok, parsed.errors.join('\n'));
  const db2 = await freshDB();
  await restoreParsed(db2, parsed);
  const b2 = await buildBackup(db2);
  eq(JSON.stringify(b2.stores), JSON.stringify(b1.stores), 'stores identical after round trip');
  eq(JSON.stringify(b2.nextIds), JSON.stringify(b1.nextIds));
  eq(b2.settings.logo.name, 'x.png');
  const before = JSON.stringify((await buildBackup(db2)).stores);
  const bad = (mut) => { const o = JSON.parse(text); mut(o); return JSON.stringify(o); };
  const cases = {
    malformed: '{ not json',
    duplicate: bad((o) => o.stores.clients.push({ ...o.stores.clients[1] })),
    missingProject: bad((o) => { o.stores.income[0].ProjectID = 9999; }),
    future: bad((o) => { o.backupVersion = 99; }),
    badMoney: bad((o) => { o.stores.income[0].AmountPaid = 12.5; }),
    missingStore: bad((o) => { delete o.stores.payouts; }),
    accessFile: JSON.stringify({ format: 'engineeredplans-access-export', formatVersion: 1, tables: {} }),
  };
  for (const [name, t] of Object.entries(cases)) { const p = parseBackup(t); assert(!p.ok && p.errors.length, `${name} must be rejected`); }
  await rejects(restoreParsed(db2, parseBackup(cases.duplicate)), /invalid/);
  // simulated aborted transaction after writes
  const other = parseBackup(bad((o) => { o.stores.clients[1].ClientName = 'CHANGED'; }));
  assert(other.ok);
  await rejects(restoreParsed(db2, other, { _testFailAfterWrites: true }), /Simulated/);
  eq(JSON.stringify((await buildBackup(db2)).stores), before, 'aborted restore left data unchanged');
});

test('Access import: preserves IDs, nulls, four-decimal money; rejects bad references', async () => {
  const src = {
    format: 'engineeredplans-access-export', formatVersion: 1,
    tables: {
      tblClients: [{ ClientID: 3, IsInternal: true, ClientName: 'Internal' }, { ClientID: 7, IsInternal: false, ClientName: 'C' }],
      tblProjects: [{ ProjectID: 15, ClientID: 3, ProjectName: 'Bank Fees', ProjectType: 'Internal' }, { ProjectID: 20, ClientID: 7, ProjectName: 'P', ProjectType: 'Client' }, { ProjectID: 21, ClientID: 3, ProjectName: 'Misc', ProjectType: 'Internal' }],
      tblPeople: [{ PersonID: 5, PersonName: 'A', MonthlyReferenceValue: '30000.0000', ReferenceHours: 80.0, RateNotes: null, BankName: ' Bank ', AccountName: null, IBAN: 'PK86  X' }],
      tblSalespeople: [], tblProjectIncome: [{ IncomeID: 4, ProjectID: 20, StartDate: '2026-09-01', EndDate: null, AmountPaid: '118481.8780', IncomeNotes: null }],
      tblTimeEntries: [{ TimeEntryID: 2, WorkDate: '2026-05-01', ProjectID: 20, PersonID: 5, WorkTask: null, HoursWorked: 24.07, HoursBilled: 24.07, RateOverride: null }],
      tblProjectCosts: [{ CostID: 9, StartDate: '2026-09-02', EndDate: '2026-08-01', ProjectID: 15, CostItem: null, CostAmount: '10.5', CostNotes: null }],
      tblSalesActivities: [], tblSalesPayouts: [], tblClientAcquisitions: [],
    },
  };
  const parsed = parseAccessExport(JSON.stringify(src));
  assert(parsed.ok, parsed.errors.join('\n'));
  eq(parsed.categoryMap.length, 1);
  const db = await freshDB();
  await importParsed(db, parsed);
  const ds = await db.loadAll();
  eq(ds.income[0].IncomeID, 4); eq(ds.income[0].AmountPaid, '118481.8780'); assert(ds.income[0].EndDate === null);
  eq(ds.costs[0].CostAmount, '10.5000'); assert(ds.costs[0].CostItem === null);
  eq(ds.timeEntries[0].HoursWorked, 24.07); eq(ds.people[0].IBAN, 'PK86  X'); eq(ds.people[0].BankName, ' Bank ');
  eq(ds.projects.find((p) => p.ProjectID === 15).CategoryCode, 'BANK_FEES');
  assert(ds.projects.find((p) => p.ProjectID === 21).CategoryCode === null);
  const c = await db.create('clients', { ClientName: 'New', IsInternal: false });
  eq(c.ClientID, 8, 'new IDs above imported maximum');
  const bad = JSON.parse(JSON.stringify(src)); bad.tables.tblProjectIncome[0].ProjectID = 99;
  assert(!parseAccessExport(JSON.stringify(bad)).ok, 'missing project rejected');
  const bad2 = JSON.parse(JSON.stringify(src)); delete bad2.tables.tblSalesPayouts;
  assert(!parseAccessExport(JSON.stringify(bad2)).ok, 'missing table rejected');
});

// J12 with the supplied source file, only when a private copy is temporarily placed in tests/private/.
test('J12 supplied Access export reconciles with source-reconciliation.json (needs a private copy in tests/private/)', async () => {
  let text, rec;
  try {
    const r1 = await fetch('./private/access-data.json'), r2 = await fetch('./private/source-reconciliation.json');
    if (!r1.ok || !r2.ok) return 'SKIP';
    text = await r1.text(); rec = await r2.json();
  } catch { return 'SKIP'; }
  const parsed = parseAccessExport(text);
  assert(parsed.ok, parsed.errors.join('\n'));
  const db = await freshDB();
  await importParsed(db, parsed);
  const ds = await db.loadAll();
  const map = { tblClients: 'clients', tblProjects: 'projects', tblPeople: 'people', tblSalespeople: 'salespeople', tblProjectIncome: 'income', tblTimeEntries: 'timeEntries', tblProjectCosts: 'costs', tblSalesActivities: 'activities', tblSalesPayouts: 'payouts', tblClientAcquisitions: 'acquisitions' };
  let total = 0;
  for (const [t, s] of Object.entries(map)) { eq(ds[s].length, rec.recordCounts[t], t); total += ds[s].length; }
  eq(total, rec.totalRecords);
  const idx = buildIndex(ds);
  const c = companyTotals(idx);
  const a = rec.allTime;
  eq(c.income.toMoney(), a.amountPaid, 'amountPaid'); eq(c.recordedCosts.toMoney(), a.recordedCosts, 'recordedCosts');
  eq(c.salesFees.toMoney(), a.salesFeesEarned, 'salesFees'); eq(c.companyResult.toMoney(), a.companyResult, 'companyResult');
  eq(c.ownerSalary.toMoney(), a.ownerSalaryCosts); eq(c.beforeOwner.toMoney(), a.totalBeforeOwnerSalary); eq(c.netAfterOwner.toMoney(), a.netAfterOwnerSalary);
  eq(c.timeValue.toMoney(), a.analyticalTimeValue, 'timeValue'); eq(c.hoursWorked.toFixed(2), a.hoursWorked); eq(c.hoursBilled.toFixed(2), a.hoursBilled);
  const s = salesSummary(idx);
  eq(Dec.sum(s.map((x) => x.paidOut)).toMoney(), a.salesPaidOut); eq(Dec.sum(s.map((x) => x.owed)).toMoney(), a.salesCommissionOwed);
  const cats = { 'Client Project Costs': c.clientCosts, 'Team Salaries': c.categories.TEAM_SALARIES, 'Client Acquisition': c.categories.CLIENT_ACQUISITION, 'Operations Cost': c.categories.OPERATIONS_COST, 'Equipment Cost': c.categories.EQUIPMENT_COST, 'Owners Salary': c.categories.OWNERS_SALARY, 'Bank Fees': c.categories.BANK_FEES };
  for (const [k, v] of Object.entries(rec.costCategories)) eq(cats[k].toMoney(), v, k);
  const rows = projectRows(idx, {});
  for (const p of rec.projects) {
    const r = rows.find((x) => x.projectId === p.ProjectID);
    eq(r.paid.toMoney(), p.amountPaid, `P${p.ProjectID} paid`); eq(r.costs.toMoney(), p.projectCosts, `P${p.ProjectID} costs`);
    eq(r.salesFees.toMoney(), p.salesFeesEarned); eq(r.actualResult.toMoney(), p.actualResult, `P${p.ProjectID} result`);
    eq(r.timeValue.toMoney(), p.timeValue, `P${p.ProjectID} time`);
    eq(r.afterTime === null ? null : r.afterTime.toMoney(), p.resultAfterTime, `P${p.ProjectID} after`);
  }
  // Export -> restore preserves source strings, nulls and IDs exactly
  const b = await buildBackup(db);
  const db2 = await freshDB();
  await restoreParsed(db2, parseBackup(backupJSON(b)));
  const ds2 = await db2.loadAll();
  const src = JSON.parse(text).tables;
  for (const [t, s] of Object.entries(map)) for (const row of src[t]) {
    const key = Object.keys(row).find((k) => k.endsWith('ID'));
    const got = ds2[s].find((x) => x[Object.keys(row)[0]] === row[Object.keys(row)[0]]) || ds2[s].find((x) => x[key] === row[key]);
    for (const [k, v] of Object.entries(row)) eq(JSON.stringify(got[k]), JSON.stringify(v), `${t}.${k}`);
  }
});

test('recurring (db): generates into income/costs once, advances GeneratedThrough, never recreates deleted occurrences', async () => {
  const db = await freshDB();
  const c = await db.create('clients', { ClientName: 'Retainer Co', IsInternal: false });
  const p = await db.create('projects', { ClientID: c.ClientID, ProjectName: 'Retainer', ProjectType: 'Client' });
  const rule = await db.create('recurring', { Kind: 'Cost', ProjectID: 4, Name: 'Google Workspace', Amount: '5000.0000', StartDate: '2026-08-11', IntervalCount: 1, IntervalUnit: 'month', GeneratedThrough: '2099-01-01' });
  assert(rule.GeneratedThrough === null, 'form cannot set GeneratedThrough');
  await db.create('recurring', { Kind: 'Income', ProjectID: p.ProjectID, Name: 'Monthly retainer', Amount: '50000.0000', StartDate: '2026-09-01', EndDate: '2026-09-30', IntervalCount: 1, IntervalUnit: 'month' });
  let r = await db.generateRecurring('2026-09-10');
  eq(r.costs, 2); eq(r.income, 1);
  let ds = await db.loadAll();
  eq(ds.costs.map((x) => x.StartDate).sort().join(), '2026-08-11,2026-09-11');
  eq(ds.costs[0].CostItem, 'Google Workspace'); eq(ds.costs[0].CostAmount, '5000.0000'); eq(ds.costs[0].RecurringID, rule.RecurringID);
  eq(ds.income[0].AmountPaid, '50000.0000'); eq(ds.income[0].IncomeNotes, 'Monthly retainer');
  eq(ds.recurring.find((x) => x.RecurringID === rule.RecurringID).GeneratedThrough, '2026-09-11');
  r = await db.generateRecurring('2026-09-10'); eq(r.costs + r.income, 0, 'idempotent');
  await Promise.all([db.generateRecurring('2026-09-28'), db.generateRecurring('2026-09-28')]); // concurrent runs; Oct 11 is 13 days away
  ds = await db.loadAll(); eq(ds.costs.length, 3, 'Oct 11 added exactly once'); eq(ds.income.length, 1, 'end date respected');
  const oct = ds.costs.find((x) => x.StartDate === '2026-10-11');
  await db.remove('costs', oct.CostID, oct.revision);
  await db.generateRecurring('2026-09-30'); ds = await db.loadAll(); eq(ds.costs.length, 2, 'deleted occurrence not recreated');
  const cur = ds.recurring.find((x) => x.RecurringID === rule.RecurringID);
  const u = await db.update('recurring', { ...cur, Amount: '5500.0000', GeneratedThrough: null }, cur.revision);
  eq(u.GeneratedThrough, '2026-10-11', 'editing a rule keeps its progress'); eq(u.revision, 2, 'generator did not bump revision');
  await db.generateRecurring('2026-10-30'); ds = await db.loadAll();
  eq(ds.costs.find((x) => x.StartDate === '2026-11-11').CostAmount, '5500.0000', 'new amount applies to later occurrences');
});

test('recurring (db): delete a rule with or without its entries; edit keeping or rebuilding old entries', async () => {
  const db = await freshDB();
  const mk = (name) => db.create('recurring', { Kind: 'Cost', ProjectID: 4, Name: name, Amount: '1000.0000', StartDate: '2026-07-01', IntervalCount: 1, IntervalUnit: 'month' });
  const a = await mk('Keep entries'), b = await mk('Drop entries'), c = await mk('Edit keep'), d = await mk('Edit rebuild');
  await db.generateRecurring('2026-09-10'); // Jul, Aug, Sep for each rule
  let ds = await db.loadAll();
  const count = (id) => ds.costs.filter((x) => x.RecurringID === id).length;
  eq(count(a.RecurringID), 3); eq(count(d.RecurringID), 3);
  // delete
  eq(await db.remove('recurring', a.RecurringID, a.revision), 0);
  eq(await db.remove('recurring', b.RecurringID, b.revision, { withEntries: true }), 3);
  ds = await db.loadAll();
  eq(count(a.RecurringID), 3, 'rule only: entries kept'); eq(count(b.RecurringID), 0, 'with entries: all deleted');
  // hand-edit one entry of each edited rule
  for (const rid of [c.RecurringID, d.RecurringID]) { const x = ds.costs.find((y) => y.RecurringID === rid && y.StartDate === '2026-08-01'); await db.update('costs', { ...x, CostAmount: '999.0000' }, x.revision); }
  ds = await db.loadAll();
  const rc = ds.recurring.find((x) => x.RecurringID === c.RecurringID), rd = ds.recurring.find((x) => x.RecurringID === d.RecurringID);
  // keep: even a shorter end date leaves every entry exactly as it was
  const before = JSON.stringify(ds.costs.filter((x) => x.RecurringID === c.RecurringID));
  await db.update('recurring', { ...rc, Amount: '2000.0000', EndDate: '2026-07-15' }, rc.revision, { entries: 'keep' });
  await db.generateRecurring('2026-09-12');
  ds = await db.loadAll();
  eq(JSON.stringify(ds.costs.filter((x) => x.RecurringID === c.RecurringID)), before, 'keep: entries untouched, also after the generator runs');
  // rebuild: every entry re-made from the edited rule, hand edit overwritten, new name / amount / project applied
  const u = await db.update('recurring', { ...rd, Name: 'Renamed', Amount: '2000.0000', ProjectID: 5 }, rd.revision, { entries: 'rebuild' });
  eq(u._adjusted.deleted, 3); eq(u._adjusted.created, 3); eq(u.GeneratedThrough, '2026-09-01');
  ds = await db.loadAll();
  const mine = ds.costs.filter((x) => x.RecurringID === d.RecurringID).sort((x, y) => x.StartDate.localeCompare(y.StartDate));
  eq(mine.map((x) => x.StartDate).join(), '2026-07-01,2026-08-01,2026-09-01');
  assert(mine.every((x) => x.CostAmount === '2000.0000' && x.CostItem === 'Renamed' && x.ProjectID === 5), JSON.stringify(mine));
  await db.generateRecurring('2026-09-12'); ds = await db.loadAll(); eq(ds.costs.filter((x) => x.RecurringID === d.RecurringID).length, 3, 'no duplicates after rebuild');
});

test('cost split (db): recurring rule makes one share per project; editing a cost splits it atomically', async () => {
  const db = await freshDB();
  await rejects(db.create('recurring', { Kind: 'Income', ProjectID: 4, SplitProjects: '5', Name: 'X', Amount: '100.0000', StartDate: '2026-09-01', IntervalCount: 1, IntervalUnit: 'month' }), /Only costs can be split/, 'income cannot be split');
  await rejects(db.create('recurring', { Kind: 'Cost', ProjectID: 4, SplitProjects: '5,999', Name: 'X', Amount: '100.0000', StartDate: '2026-09-01', IntervalCount: 1, IntervalUnit: 'month' }), /no longer exists/, 'unknown split project rejected');
  const rule = await db.create('recurring', { Kind: 'Cost', ProjectID: 4, SplitProjects: '5,6', Name: 'Shared tool', Amount: '10000.0000', StartDate: '2026-09-01', IntervalCount: 1, IntervalUnit: 'month' });
  const r = await db.generateRecurring('2026-09-10');
  eq(r.costs, 3, 'one occurrence -> three shares');
  let ds = await db.loadAll();
  eq(ds.costs.map((x) => `${x.ProjectID}:${x.CostAmount}`).sort().join(), '4:3333.3400,5:3333.3300,6:3333.3300');
  assert(ds.costs.every((x) => x.RecurringID === rule.RecurringID && x.CostNotes.includes('Split equally across 3 projects')), 'shares linked to the rule');
  eq(missingOccurrences(ds.recurring[0], ds).length, 0, 'three shares count as one occurrence');
  // end date before the occurrence removes all three untouched shares
  const cur = ds.recurring[0];
  const u = await db.update('recurring', { ...cur, EndDate: '2026-08-31', StartDate: '2026-08-01' }, cur.revision);
  ds = await db.loadAll(); eq(u._adjusted.deleted, 3); eq(ds.costs.length, 0);
  const p6 = ds.projects.find((p) => p.ProjectID === 6);
  await rejects(db.remove('projects', 6, p6.revision), /DependencyError/, 'project used only as a split share cannot be deleted');
  // editing an existing single cost into a split: record updated + new shares, all-or-nothing
  const c = await db.create('costs', { ProjectID: 4, StartDate: '2026-09-05', CostItem: 'Monitor', CostAmount: '9000.0000' });
  await rejects(db.updateAndCreate('costs', { ...c, CostAmount: '4500.0000' }, c.revision, [{ ...c, CostID: null, ProjectID: 999, CostAmount: '4500.0000' }]), /ValidationError/, 'bad share rejects the whole edit');
  ds = await db.loadAll(); eq(ds.costs.length, 1); eq(ds.costs[0].CostAmount, '9000.0000', 'nothing changed after the failed split');
  const out = await db.updateAndCreate('costs', { ...c, CostAmount: '4500.0000' }, c.revision, [{ ...c, CostID: null, ProjectID: 5, CostAmount: '4500.0000' }]);
  eq(out.length, 2); eq(out[0].CostID, c.CostID); eq(out[0].revision, 2);
  ds = await db.loadAll(); eq(ds.costs.map((x) => `${x.ProjectID}:${x.CostAmount}`).sort().join(), '4:4500.0000,5:4500.0000');
  await rejects(db.updateAndCreate('costs', { ...c }, c.revision, []), /StaleError/, 'stale revision refused');
});

test('contracts (db): validation, clauses, delete protection, older backups restore', async () => {
  const db = await freshDB();
  const c = await db.create('clients', { ClientName: 'Acme', IsInternal: false });
  const other = await db.create('clients', { ClientName: 'Other', IsInternal: false });
  const p = await db.create('projects', { ClientID: c.ClientID, ProjectName: 'Website', ProjectType: 'Client' });
  const q = await db.create('projects', { ClientID: other.ClientID, ProjectName: 'Ads', ProjectType: 'Client' });
  const base = { ClientID: c.ClientID, ContractName: 'Hosting 2026', ProjectIDs: String(p.ProjectID) };
  await rejects(db.create('contracts', { ...base, ProjectIDs: `${p.ProjectID},${q.ProjectID}` }), /belong to the contract/, 'another client’s project');
  await rejects(db.create('contracts', { ...base, ContractName: ' ' }), /contract name/);
  const k = await db.create('contracts', base);
  eq(k.ProjectIDs, String(p.ProjectID)); assert(!('StartDate' in k), 'contract has no dates');
  const clause = { ContractID: k.ContractID, ClauseTitle: 'Hosting', StartDate: '2026-04-07', TermYears: 2, TermMonths: null, RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', ChargeToClient: '60000.0000', CostToEngineeredPlans: '20000.0000' };
  await rejects(db.create('clauses', { ...clause, ContractID: 999 }), /contract/);
  await rejects(db.create('clauses', { ...clause, ClauseTitle: ' ' }), /Enter the clause/);
  await rejects(db.create('clauses', { ...clause, StartDate: null }), /start date|required/);
  await rejects(db.create('clauses', { ...clause, TermYears: 1.5 }), /whole number of years/);
  await rejects(db.create('clauses', { ...clause, RenewalNoticeUnit: null }), /weeks or months/, 'count without unit');
  await rejects(db.create('clauses', { ...clause, CostToEngineeredPlans: '-1.0000' }), /negative/);
  const cl = await db.create('clauses', clause);
  let ds = await db.loadAll();
  await rejects(db.remove('contracts', k.ContractID, k.revision), /DependencyError/, 'contract with clauses');
  await rejects(db.remove('projects', p.ProjectID, ds.projects.find((x) => x.ProjectID === p.ProjectID).revision), /DependencyError/, 'project covered by a contract');
  await rejects(db.remove('clients', c.ClientID, ds.clients.find((x) => x.ClientID === c.ClientID).revision), /DependencyError/, 'client with contracts');
  await db.remove('clauses', cl.ClauseID, cl.revision);
  await db.remove('contracts', k.ContractID, k.revision);
  // a version-2 backup (before contracts) still restores, with empty contract stores
  const b = await buildBackup(db);
  delete b.stores.contracts; delete b.stores.clauses; b.backupVersion = 2; b.schemaVersion = 2;
  const parsed = parseBackup(backupJSON(b));
  assert(parsed.ok, parsed.errors.join('\n')); eq(parsed.data.stores.contracts.length, 0); eq(parsed.data.stores.clauses.length, 0);
  // a version-3 backup (dates and amounts on the contract) converts its contracts to clauses
  const b3 = await buildBackup(db);
  b3.backupVersion = 3; b3.schemaVersion = 3;
  b3.stores.contracts = [{ ContractID: 1, ClientID: c.ClientID, ContractName: 'Old', StartDate: '2026-04-07', EndDate: '2028-04-07', RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', RenewalCost: null, ClientCharge: '1000.0000', ContractNotes: null, ProjectIDs: null, revision: 1 }];
  b3.stores.clauses = [];
  const p3 = parseBackup(backupJSON(b3));
  assert(p3.ok, p3.errors.join('\n')); eq(p3.data.stores.clauses.length, 1); eq(p3.data.stores.clauses[0].TermYears, 2); eq(p3.data.stores.clauses[0].ChargeToClient, '1000.0000');
  assert(!('StartDate' in p3.data.stores.contracts[0]), 'old fields removed');
});

test('schema upgrade v3 -> v4 moves contract dates and amounts onto clauses', async () => {
  const name = 'engineeredplans_test_upgrade4_' + Math.random().toString(36).slice(2);
  // Build a real version-3 database by hand (stores as v1–v3 created them) holding the user's style of contract.
  await new Promise((res, rej) => {
    const r = indexedDB.open(name, 3);
    r.onupgradeneeded = () => {
      const d = r.result;
      for (const s of ['clients', 'projects', 'people', 'salespeople', 'income', 'timeEntries', 'costs', 'activities', 'payouts', 'acquisitions', 'recurring', 'contracts', 'clauses']) d.createObjectStore(s, { keyPath: STORES[s].key });
      d.createObjectStore('meta', { keyPath: 'key' }); d.createObjectStore('settings', { keyPath: 'key' });
      const t = r.transaction;
      t.objectStore('clients').add({ ClientID: 3, ClientName: 'Jordan', IsInternal: false, Archived: null, revision: 1 });
      t.objectStore('projects').add({ ProjectID: 9, ClientID: 3, ProjectName: 'example.com', ProjectType: 'Client', CategoryCode: null, Archived: null, revision: 1 });
      t.objectStore('contracts').add({ ContractID: 1, ClientID: 3, ContractName: 'Website Hosting & Maintenance', StartDate: '2026-04-07', EndDate: '2028-04-07', RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', RenewalCost: null, ClientCharge: null, ContractNotes: null, ProjectIDs: '9', revision: 2 });
      t.objectStore('meta').add({ key: 'nextIds', value: { contracts: 2, clauses: 1 } });
    };
    r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error);
  });
  const db = await TrackerDB.open(name); opened.push(db);
  const ds = await db.loadAll();
  eq(ds.contracts.length, 1); assert(!('StartDate' in ds.contracts[0]) && !('ClientCharge' in ds.contracts[0]), 'contract fields moved');
  eq(ds.contracts[0].ProjectIDs, '9', 'projects kept');
  eq(ds.clauses.length, 1); const k = ds.clauses[0];
  eq([k.ClauseTitle, k.StartDate, k.TermYears, k.RenewalNoticeCount, k.RenewalNoticeUnit].join(), 'Main contract,2026-04-07,2,1,month');
  const added = await db.create('clauses', { ContractID: 1, ClauseTitle: 'Domain', StartDate: '2026-04-07', TermYears: 1 });
  eq(added.ClauseID, 2, 'clause IDs continue after the converted one');
  const v = validateDataset(ds); eq(v.errors.join('|'), '', 'upgraded data is valid');
});

test('schema upgrade v1 -> v2 keeps existing records and adds the recurring store', async () => {
  const name = 'engineeredplans_test_upgrade_' + Math.random().toString(36).slice(2);
  await new Promise((res, rej) => {
    const r = indexedDB.open(name, 1);
    r.onupgradeneeded = () => {
      const db = r.result;
      for (const [s, k] of [['clients', 'ClientID'], ['projects', 'ProjectID'], ['people', 'PersonID'], ['salespeople', 'SalespersonID'], ['income', 'IncomeID'], ['timeEntries', 'TimeEntryID'], ['costs', 'CostID'], ['activities', 'ActivityID'], ['payouts', 'PayoutID'], ['acquisitions', 'AcquisitionID']]) db.createObjectStore(s, { keyPath: k });
      db.createObjectStore('meta', { keyPath: 'key' }); db.createObjectStore('settings', { keyPath: 'key' });
      r.transaction.objectStore('clients').add({ ClientID: 7, ClientName: 'Kept', IsInternal: false, Archived: null, revision: 1 });
    };
    r.onsuccess = () => { r.result.close(); res(); }; r.onerror = () => rej(r.error);
  });
  const db = await TrackerDB.open(name); opened.push(db);
  const ds = await db.loadAll();
  eq(ds.clients.length, 1, 'no reseed on upgrade'); eq(ds.clients[0].ClientName, 'Kept'); eq(ds.recurring.length, 0);
  eq(ds.contracts.length, 0, 'v3 contract stores created'); eq(ds.clauses.length, 0);
  const rule = await db.create('recurring', { Kind: 'Cost', ProjectID: null, Name: 'x', Amount: '1.0000', StartDate: '2026-01-01', IntervalCount: 1, IntervalUnit: 'month' }).catch((e) => e);
  eq(rule.name, 'ValidationError', 'project still required');
});

test('backup version 1 (before recurring) still restores', async () => {
  const db = await freshDB();
  const b = await buildBackup(db);
  delete b.stores.recurring; b.backupVersion = 1; b.schemaVersion = 1;
  const p = parseBackup(JSON.stringify(b));
  assert(p.ok, p.errors.join('\n')); eq(p.data.stores.recurring.length, 0);
});

test('end date (db): ending a rule early removes later untouched entries inside the update transaction', async () => {
  const db = await freshDB();
  const rule = await db.create('recurring', { Kind: 'Cost', ProjectID: 5, Name: 'Ayesha Salary', Amount: '30000.0000', StartDate: '2026-09-01', IntervalCount: 1, IntervalUnit: 'month' });
  await db.generateRecurring('2026-10-20'); // creates Sep 1, Oct 1, Nov 1 (Nov 1 is 12 days away)
  let ds = await db.loadAll(); eq(ds.costs.length, 3);
  const cur = ds.recurring[0];
  const u = await db.update('recurring', { ...cur, EndDate: '2026-10-15' }, cur.revision);
  eq(u._adjusted.updated, 0); eq(u._adjusted.deleted, 1);
  ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.StartDate}=${c.CostAmount}`).sort().join(), '2026-09-01=30000.0000,2026-10-01=30000.0000'); // October in full
  eq(ds.recurring[0].GeneratedThrough, '2026-10-01');
  eq((await db.generateRecurring('2026-12-01')).costs, 0, 'nothing after the end date');
  // extending again resumes November
  const c2 = ds.recurring[0];
  await db.update('recurring', { ...c2, EndDate: null }, c2.revision);
  await db.generateRecurring('2026-10-20');
  ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.StartDate}=${c.CostAmount}`).sort().join(), '2026-09-01=30000.0000,2026-10-01=30000.0000,2026-11-01=30000.0000');
});

test('recurring: deleted entries are re-created on request with the corrected amount, then never duplicated', async () => {
  const db = await freshDB();
  const c = await db.create('clients', { ClientName: 'Acme', IsInternal: false });
  const p = await db.create('projects', { ClientID: c.ClientID, ProjectName: 'Social Content', ProjectType: 'Client' });
  const rule = await db.create('recurring', { Kind: 'Income', ProjectID: p.ProjectID, Name: 'Social Content', Amount: '44514.5200', StartDate: '2026-10-01', IntervalCount: 1, IntervalUnit: 'month' });
  await db.generateRecurring('2026-10-20');
  let ds = await db.loadAll(); eq(ds.income.length, 2);
  const cur = ds.recurring[0];
  await db.update('recurring', { ...cur, Amount: '56149.0600' }, cur.revision);
  for (const i of ds.income) await db.remove('income', i.IncomeID, i.revision);
  eq((await db.generateRecurring('2026-10-20')).income, 0, 'deleted entries are not recreated automatically');
  ds = await db.loadAll();
  eq(missingOccurrences(ds.recurring[0], ds).join(), '2026-10-01,2026-11-01');
  const made = await db.recreateMissingRecurring(rule.RecurringID);
  eq(made.length, 2); eq(made.map((x) => x.AmountPaid).join(), '56149.0600,56149.0600');
  ds = await db.loadAll(); eq(missingOccurrences(ds.recurring[0], ds).length, 0);
  eq((await db.recreateMissingRecurring(rule.RecurringID)).length, 0, 'second click adds nothing');
  eq((await db.generateRecurring('2026-10-20')).income, 0); eq((await db.loadAll()).income.length, 2);
});
test('recurring (db): switching to the two-week window removes untouched far-ahead entries and re-adds them on time', async () => {
  const db = await freshDB();
  const ds0 = await db.loadAll();
  const rule = (id, name, amt) => ({ RecurringID: id, Kind: 'Cost', ProjectID: 4, Name: name, Amount: amt, StartDate: '2026-10-01', EndDate: null, IntervalCount: 1, IntervalUnit: 'month', Notes: null, GeneratedThrough: '2026-11-01', Proration: null, Archived: null });
  const cost = (id, rid, name, d, amt) => ({ CostID: id, StartDate: d, EndDate: null, ProjectID: 4, CostItem: name, CostAmount: amt, CostNotes: null, RecurringID: rid });
  ds0.recurring = [rule(1, 'ChatGPT', '5527.3200'), rule(2, 'Hosting', '1000.0000')];
  ds0.costs = [cost(1, 1, 'ChatGPT', '2026-10-01', '5527.3200'), cost(2, 1, 'ChatGPT', '2026-11-01', '5527.3200'), cost(3, 2, 'Hosting', '2026-10-01', '1000.0000'), cost(4, 2, 'Hosting', '2026-11-01', '1200.0000')];
  await db.replaceAll(ds0, {}); // state as left by the old one-month window (made on 2026-10-03)
  const r = await db.generateRecurring('2026-10-03');
  eq(r.removed, 1); eq(r.costs, 0);
  let ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.CostItem} ${c.StartDate}`).sort().join(), 'ChatGPT 2026-10-01,Hosting 2026-10-01,Hosting 2026-11-01', 'hand-edited Hosting Nov entry kept');
  eq((await db.generateRecurring('2026-10-17')).costs, 0, 'Nov 1 is 15 days away');
  eq((await db.generateRecurring('2026-10-18')).costs, 1, 'Nov 1 added 14 days ahead, once');
  ds = await db.loadAll();
  eq(ds.costs.filter((c) => c.StartDate === '2026-11-01').length, 2, 'one ChatGPT + the kept Hosting, no duplicate Hosting');
});