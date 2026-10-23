// Data Quality: reports anomalies (mostly from imported/restored data) without rewriting anything.
import { STORES, STORE_NAMES, ACTIVITY_TYPES, PROJECT_TYPES, CATEGORY_BY_CODE } from '../model/schema.js';
import { isValidISODate, todayISO } from '../lib/dates.js';
import { Dec } from '../lib/decimal.js';
import { buildIndex, projectLabel, clientNameById } from './calc.js';
import { parseIdList } from './recurring.js';

const neg = (v) => v !== null && v !== undefined && Dec.from(v).sign() < 0;

// Income records (dated today or earlier) with no invoice attached. Future-dated income is counted separately: its
// invoice may not exist yet. Returns { total, withInvoice, without, pct (0–100, null when there is no income), future }.
export function invoiceCoverage(ds, today = todayISO()) {
  const has = new Set((ds.attachments || []).filter((a) => a.Store === 'income').map((a) => a.RecordID));
  const due = ds.income.filter((i) => i.StartDate <= today);
  const withInvoice = due.filter((i) => has.has(i.IncomeID)).length;
  return { total: due.length, withInvoice, without: due.length - withInvoice, pct: due.length ? ((due.length - withInvoice) / due.length) * 100 : null, future: ds.income.length - due.length };
}

export function dataQualityIssues(ds) {
  const idx = buildIndex(ds);
  const out = [];
  const add = (store, rec, field, message, severity = 'warning') => out.push({ store, id: rec[STORES[store].key], field, message, severity });

  // Missing references
  const ids = Object.fromEntries(STORE_NAMES.map((s) => [s, new Set((ds[s] || []).map((r) => r[STORES[s].key]))]));
  for (const s of STORE_NAMES) {
    for (const [k, fd] of Object.entries(STORES[s].fields)) {
      if (fd.type !== 'fk') continue;
      for (const r of ds[s] || []) if (r[k] !== null && !ids[fd.ref].has(r[k])) add(s, r, k, `${k} ${r[k]} refers to a record that does not exist`, 'error');
    }
  }
  for (const c of ds.contracts || []) {
    for (const pid of parseIdList(c.ProjectIDs)) {
      const p = idx.projects.get(pid);
      if (!p) add('contracts', c, 'ProjectIDs', `Contract "${c.ContractName}" covers project #${pid}, which does not exist`, 'error');
      else if (p.ClientID !== c.ClientID) add('contracts', c, 'ProjectIDs', `Contract "${c.ContractName}" covers "${projectLabel(idx, pid)}", which belongs to another client`);
    }
    if (!(ds.clauses || []).some((k) => k.ContractID === c.ContractID)) add('contracts', c, 'ContractID', `Contract "${c.ContractName}" has no clauses, so it has no dates or amounts`, 'info');
  }
  for (const [s, dateF] of [['income', 'StartDate'], ['costs', 'StartDate']]) {
    for (const r of ds[s]) {
      if (!isValidISODate(r[dateF])) add(s, r, dateF, 'Start date is not a valid date', 'error');
      if (r.EndDate !== null && r.EndDate < r.StartDate) add(s, r, 'EndDate', `End date ${r.EndDate} is earlier than start date ${r.StartDate}`);
    }
  }
  for (const r of ds.income) if (neg(r.AmountPaid)) add('income', r, 'AmountPaid', 'Amount paid is negative');
  for (const r of ds.costs) if (neg(r.CostAmount)) add('costs', r, 'CostAmount', 'Cost amount is negative');

  for (const p of ds.projects) {
    const c = idx.clients.get(p.ClientID);
    if (!PROJECT_TYPES.includes(p.ProjectType)) add('projects', p, 'ProjectType', `Project type "${p.ProjectType}" is not Client or Internal`, 'error');
    else if (c && c.IsInternal && p.ProjectType !== 'Internal') add('projects', p, 'ProjectType', `Client project "${p.ProjectName}" belongs to internal client "${c.ClientName}"`);
    else if (c && !c.IsInternal && p.ProjectType !== 'Client') add('projects', p, 'ProjectType', `Internal project "${p.ProjectName}" belongs to non-internal client "${c.ClientName}" (its costs count as Other Internal Costs)`);
    if (p.ProjectType === 'Internal' && !CATEGORY_BY_CODE[p.CategoryCode]) add('projects', p, 'CategoryCode', `Internal project "${p.ProjectName}" has no company cost category, so its costs appear under Other Internal Costs`, 'info');
  }
  for (const p of ds.people) {
    if (!(p.ReferenceHours > 0)) add('people', p, 'ReferenceHours', `${p.PersonName}: reference hours must be greater than zero, so the default hourly value cannot be calculated`, 'error');
    if (p.MonthlyReferenceValue === null) add('people', p, 'MonthlyReferenceValue', `${p.PersonName}: monthly salary is blank`);
    else if (neg(p.MonthlyReferenceValue)) add('people', p, 'MonthlyReferenceValue', `${p.PersonName}: monthly salary is negative`);
    // Owners (ticked as owner, or paid from Owners Salary) have no join or leave date by design.
    const owner = !!p.IsOwner || p.SalaryCategory === 'OWNERS_SALARY';
    if (!p.Archived && !owner && !p.JoinDate) add('people', p, 'JoinDate', `${p.PersonName}: no join date, so no salary costs are added`, 'info');
  }
  const spByPerson = new Map();
  for (const s of ds.salespeople) {
    if (s.CloseRate === null || s.CloseRate < 0 || s.CloseRate > 1) add('salespeople', s, 'CloseRate', 'Close rate is blank or outside 0–100%', 'error');
    if (s.MeetingFee === null) add('salespeople', s, 'MeetingFee', 'Meeting fee is blank');
    else if (neg(s.MeetingFee)) add('salespeople', s, 'MeetingFee', 'Meeting fee is negative');
    if (spByPerson.has(s.PersonID)) add('salespeople', s, 'PersonID', `Employee already has another sales profile (#${spByPerson.get(s.PersonID)})`);
    spByPerson.set(s.PersonID, s.SalespersonID);
  }
  for (const t of ds.timeEntries) {
    if (t.HoursWorked === null || t.HoursWorked < 0) add('timeEntries', t, 'HoursWorked', 'Hours worked is blank or negative');
    if (t.HoursBilled === null || t.HoursBilled < 0) add('timeEntries', t, 'HoursBilled', 'Hours billed is blank or negative');
    if (neg(t.RateOverride)) add('timeEntries', t, 'RateOverride', 'Rate override is negative');
    const person = idx.people.get(t.PersonID);
    if (t.RateOverride === null && person && !(person.ReferenceHours > 0 && person.MonthlyReferenceValue !== null)) add('timeEntries', t, 'PersonID', `Time value unavailable: ${person.PersonName} has no valid salary/reference hours`);
  }
  for (const a of ds.activities) {
    if (!ACTIVITY_TYPES.includes(a.ActivityType)) add('activities', a, 'ActivityType', `Activity type "${a.ActivityType}" is not Close or Attended meeting (calculated like a meeting fee, as in Access)`, 'error');
    if (a.CloseRateOverride !== null && (a.CloseRateOverride < 0 || a.CloseRateOverride > 1)) add('activities', a, 'CloseRateOverride', 'Close rate override outside 0–100%');
    for (const k of ['PaidAmountCredited', 'BaseOverride', 'MeetingFeeOverride', 'CommissionPaid']) if (neg(a[k])) add('activities', a, k, `${k} is negative`);
  }
  for (const p of ds.payouts) if (!(Dec.from(p.AmountPaid).sign() > 0)) add('payouts', p, 'AmountPaid', 'Payout amount is not greater than zero');
  for (const a of ds.acquisitions) {
    const c = idx.clients.get(a.ClientID);
    if (c?.IsInternal) add('acquisitions', a, 'ClientID', `Acquisition is for internal client "${c.ClientName}"`, 'error');
    if (a.AcquisitionRate < 0 || a.AcquisitionRate > 1) add('acquisitions', a, 'AcquisitionRate', 'Acquisition rate outside 0–100%', 'error');
  }
  const rank = { error: 0, warning: 1, info: 2 };
  out.sort((a, b) => rank[a.severity] - rank[b.severity] || a.store.localeCompare(b.store) || a.id - b.id);
  return out.map((i) => ({ ...i, label: describe(idx, i) }));
}

function describe(idx, i) {
  const r = idx.ds[i.store].find((x) => x[STORES[i.store].key] === i.id);
  if (!r) return '';
  if ('ProjectID' in r && i.store !== 'projects') return projectLabel(idx, r.ProjectID);
  if (i.store === 'projects') return projectLabel(idx, r.ProjectID);
  if (i.store === 'contracts') return `${clientNameById(idx, r.ClientID)} / ${r.ContractName}`;
  if (i.store === 'clients' || i.store === 'acquisitions') return clientNameById(idx, r.ClientID);
  return r.PersonName || r.ClauseTitle || '';
}
