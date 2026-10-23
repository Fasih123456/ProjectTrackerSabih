// Small fictional fixtures for tests and the explicitly selected demo mode. Never real business data.
import { STORE_NAMES, INTERNAL_SETUP } from '../model/schema.js';

export function emptyDs() { return Object.fromEntries(STORE_NAMES.map((s) => [s, []])); }

// Builder with auto IDs and Access-shaped records (money as 4-decimal strings).
export function builder({ internal = true } = {}) {
  const ds = emptyDs();
  const ids = Object.fromEntries(STORE_NAMES.map((s) => [s, 1]));
  const m = (v) => (v === null || v === undefined ? null : Number(v).toFixed(4));
  const next = (s) => ids[s]++;
  if (internal) {
    ds.clients.push({ ...INTERNAL_SETUP.client }); ids.clients = 2;
    for (const p of INTERNAL_SETUP.projects) ds.projects.push({ ...p });
    ids.projects = INTERNAL_SETUP.projects.length + 1;
  }
  const b = {
    ds,
    client(name, isInternal = false) { const r = { ClientID: next('clients'), ClientName: name, IsInternal: isInternal, Archived: null }; ds.clients.push(r); return r.ClientID; },
    project(clientId, name, type = 'Client', code = null) { const r = { ProjectID: next('projects'), ClientID: clientId, ProjectName: name, ProjectType: type, CategoryCode: code, Archived: null }; ds.projects.push(r); return r.ProjectID; },
    person(name, monthly, hours, bank = {}) { const r = { PersonID: next('people'), PersonName: name, MonthlyReferenceValue: m(monthly), ReferenceHours: hours, RateNotes: null, BankName: bank.bank ?? null, AccountName: bank.account ?? null, IBAN: bank.iban ?? null, Archived: null }; ds.people.push(r); return r.PersonID; },
    salesperson(personId, rate, fee) { const r = { SalespersonID: next('salespeople'), PersonID: personId, CloseRate: rate, MeetingFee: m(fee), Archived: null }; ds.salespeople.push(r); return r.SalespersonID; },
    income(projectId, start, amount, end = null, notes = null) { const r = { IncomeID: next('income'), ProjectID: projectId, StartDate: start, EndDate: end, AmountPaid: m(amount), IncomeNotes: notes }; ds.income.push(r); return r.IncomeID; },
    time(projectId, personId, date, worked, billed = worked, override = null, task = null) { const r = { TimeEntryID: next('timeEntries'), WorkDate: date, ProjectID: projectId, PersonID: personId, WorkTask: task, HoursWorked: worked, HoursBilled: billed, RateOverride: m(override) }; ds.timeEntries.push(r); return r.TimeEntryID; },
    cost(projectId, start, amount, item = null, end = null, notes = null) { const r = { CostID: next('costs'), StartDate: start, EndDate: end, ProjectID: projectId, CostItem: item, CostAmount: m(amount), CostNotes: notes }; ds.costs.push(r); return r.CostID; },
    activity(projectId, spId, date, type, o = {}) { const r = { ActivityID: next('activities'), ActivityDate: date, ProjectID: projectId, SalespersonID: spId, ActivityType: type, LeadNotes: o.notes ?? null, PaidAmountCredited: m(o.credited), BaseOverride: m(o.base), CloseRateOverride: o.rate ?? null, MeetingFeeOverride: m(o.fee), CommissionPaid: m(o.paid) }; ds.activities.push(r); return r.ActivityID; },
    payout(spId, date, amount, notes = null) { const r = { PayoutID: next('payouts'), SalespersonID: spId, PayoutDate: date, AmountPaid: m(amount), PayoutNotes: notes }; ds.payouts.push(r); return r.PayoutID; },
    acquisition(clientId, spId, date, rate, notes = null) { const r = { AcquisitionID: next('acquisitions'), ClientID: clientId, SalespersonID: spId, AcquisitionDate: date, AcquisitionRate: rate, AcquisitionNotes: notes }; ds.acquisitions.push(r); return r.AcquisitionID; },
  };
  return b;
}

// Minimal fictional starter records: two clients with one project each (on top of the internal setup).
export function starterDataset() {
  const b = builder();
  const acme = b.client('Sample Client — Acme Traders'), green = b.client('Sample Client — Greenleaf Studio');
  b.project(acme, 'Website redesign');
  b.project(green, 'Mobile app');
  return b.ds;
}

// The starting state for "Reset all data": the internal setup, optionally with the starter records.
export function resetDataset({ sample = false } = {}) { return sample ? starterDataset() : builder().ds; }

// Adds the starter records once, on the first start of a database that holds nothing but the internal setup.
// Returns true when they were added. Never touches a database that already has records of its own.
export async function seedStarterData(db) {
  if (await db.getMeta('starterSeededAt')) return false;
  const ds = await db.loadAll();
  const onlySetup = STORE_NAMES.every((s) => s === 'clients' ? ds.clients.every((c) => c.ClientID === INTERNAL_SETUP.client.ClientID)
    : s === 'projects' ? ds.projects.every((p) => INTERNAL_SETUP.projects.some((q) => q.ProjectID === p.ProjectID)) : !ds[s].length);
  if (onlySetup) await db.replaceAll(starterDataset());
  await db.setMeta('starterSeededAt', new Date().toISOString());
  return onlySetup;
}

// Fictional demo dataset (demo database only).
export function demoDataset() {
  const b = builder();
  const acme = b.client('Demo Client — Northwind'), blue = b.client('Demo Client — Bluebird');
  const web = b.project(acme, 'Website rebuild'), seo = b.project(acme, 'SEO retainer'), ads = b.project(blue, 'Ads management');
  const ana = b.person('Demo Analyst', 320000, 160, { bank: 'Demo Bank', account: 'DEMO ANALYST', iban: 'PK00 DEMO 0000 0000 0000 0001' });
  const des = b.person('Demo Designer', 30000, 80);
  const sal = b.person('Demo Sales Lead', 100000, 160, { bank: 'Demo Bank', account: 'D. SALES LEAD' });
  const sp = b.salesperson(sal, 0.05, 2000);
  b.income(web, '2026-07-05', 150000, '2026-08-31', 'Milestone 1');
  b.income(seo, '2026-08-01', 40000, '2026-10-31', 'Quarterly retainer');
  b.income(ads, '2026-09-10', 60000);
  b.time(web, ana, '2026-07-12', 12.5, 10, null, 'Build pages');
  b.time(seo, des, '2026-08-03', 6, 6, null, 'Graphics');
  b.time(ads, ana, '2026-09-11', 3.3, 3.3, null, 'Campaign setup');
  b.cost(web, '2026-07-06', 12000, 'Theme licence');
  b.cost(5, '2026-07-31', 50000, 'July team salaries');
  b.cost(2, '2026-08-15', 8000, 'Lead ads');
  b.cost(6, '2026-08-31', 60000, 'Owner salary August');
  b.cost(1, '2026-09-01', 1500, 'Transfer fees');
  b.activity(ads, sp, '2026-09-05', 'Close', { credited: 60000, notes: 'Closed Bluebird ads' });
  b.activity(2, sp, '2026-08-20', 'Attended meeting', { notes: 'Discovery call' });
  b.acquisition(acme, sp, '2026-07-01', 0.05, 'Northwind acquisition');
  b.payout(sp, '2026-09-20', 5000, 'Partial payment');
  return b.ds;
}
