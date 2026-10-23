// Pure business calculations. Every screen, report, dashboard figure and CSV export uses these.
// Aggregation is keyed by stable IDs; display names are joined only at the end.

import { Dec, roundCurrency4 } from '../lib/decimal.js';
import { addDays, inRange, monthOf, todayISO } from '../lib/dates.js';
import { CATEGORY_BY_CODE, COST_CATEGORIES } from '../model/schema.js';
import { contractEndedProjects } from './contracts.js';

const Z = () => Dec.zero();
const dz = (v) => (v === null || v === undefined ? Z() : Dec.from(v));

export function buildIndex(ds) {
  const byId = (rows, key) => new Map(rows.map((r) => [r[key], r]));
  const idx = {
    ds,
    clients: byId(ds.clients, 'ClientID'),
    projects: byId(ds.projects, 'ProjectID'),
    people: byId(ds.people, 'PersonID'),
    salespeople: byId(ds.salespeople, 'SalespersonID'),
    acqByClient: new Map(ds.acquisitions.map((a) => [a.ClientID, a])),
    incomeByProject: new Map(),
    contractEnded: contractEndedProjects(ds, todayISO()), // projects whose contracts have all ended: treated as archived
  };
  for (const i of ds.income) { if (!idx.incomeByProject.has(i.ProjectID)) idx.incomeByProject.set(i.ProjectID, []); idx.incomeByProject.get(i.ProjectID).push(i); }
  return idx;
}

// ---------- labels ----------
export const clientOf = (idx, projectId) => idx.clients.get(idx.projects.get(projectId)?.ClientID) || null;
// "{name} - {company name}" (just the name when no company is recorded); used wherever a client is shown.
export const clientLabel = (c) => (!c ? '—' : c.CompanyName ? `${c.ClientName} - ${c.CompanyName}` : c.ClientName);
export const clientNameById = (idx, clientId) => (idx.clients.has(clientId) ? clientLabel(idx.clients.get(clientId)) : '—');
export function projectLabel(idx, projectId) {
  const p = idx.projects.get(projectId);
  if (!p) return `Missing project #${projectId}`;
  const c = idx.clients.get(p.ClientID);
  return `${c ? clientLabel(c) : `Missing client #${p.ClientID}`} / ${p.ProjectName}`;
}
export const personName = (idx, id) => idx.people.get(id)?.PersonName ?? `Missing employee #${id}`;
export function salespersonName(idx, id) {
  const s = idx.salespeople.get(id);
  if (!s) return `Missing salesperson #${id}`;
  return idx.people.get(s.PersonID)?.PersonName ?? `Salesperson #${id}`;
}

// ---------- time ----------
// Default hourly value = MonthlyReferenceValue / ReferenceHours (null when not computable).
export function defaultHourly(person) {
  if (!person || person.MonthlyReferenceValue === null || !(person.ReferenceHours > 0)) return null;
  return Dec.from(person.MonthlyReferenceValue).div(Dec.from(person.ReferenceHours), 10);
}

// hourlyValue = RateOverride ?? default; timeValue = HoursWorked x hourlyValue. Zero override is a real zero.
export function timeEntryValue(entry, person) {
  let hourly = null, value = null;
  if (entry.RateOverride !== null && entry.RateOverride !== undefined) {
    hourly = Dec.from(entry.RateOverride);
    if (entry.HoursWorked !== null) value = Dec.from(entry.HoursWorked).mul(hourly);
  } else if (person && person.MonthlyReferenceValue !== null && person.ReferenceHours > 0) {
    hourly = defaultHourly(person);
    // multiply before dividing for exactness: hours x monthly / refHours
    if (entry.HoursWorked !== null) value = Dec.from(entry.HoursWorked).mul(person.MonthlyReferenceValue).div(Dec.from(person.ReferenceHours), 10);
  }
  return { hourly, value, overridden: entry.RateOverride !== null && entry.RateOverride !== undefined };
}

// Splitting one expense equally across projects (shared with recurring rules).
export { splitEqually } from './recurring.js';

// ---------- ordinary sales activities ----------
// Mirrors qSalesCommission: Close -> suppressed (0) if the project's client has an acquisition record,
// else (BaseOverride ?? PaidAmountCredited ?? 0) x (CloseRateOverride ?? CloseRate); any other type -> meeting fee.
export function activityEarning(idx, act) {
  const sp = idx.salespeople.get(act.SalespersonID) || null;
  const project = idx.projects.get(act.ProjectID) || null;
  const legacyPaid = dz(act.CommissionPaid);
  let earned = Z(), credited = dz(act.PaidAmountCredited), suppressed = false, base = null, rate = null, fee = null;
  if (act.ActivityType === 'Close') {
    suppressed = !!project && idx.acqByClient.has(project.ClientID);
    if (suppressed) { credited = Z(); }
    else {
      base = act.BaseOverride ?? act.PaidAmountCredited ?? null;
      rate = act.CloseRateOverride ?? sp?.CloseRate ?? null;
      earned = base === null || rate === null ? Z() : Dec.from(base).mul(Dec.from(rate));
    }
  } else {
    fee = act.MeetingFeeOverride ?? sp?.MeetingFee ?? null;
    earned = dz(fee);
  }
  return { earned, credited, suppressed, base, rate, fee, legacyPaid, owed: earned.sub(legacyPaid) };
}

// ---------- client acquisitions (180-day recurring commission) ----------
export const acquisitionWindowEnd = (acqDate) => addDays(acqDate, 180); // exclusive stop date

export function acquisitionLines(idx) {
  const lines = [];
  for (const a of idx.ds.acquisitions) {
    const windowEnd = acquisitionWindowEnd(a.AcquisitionDate);
    for (const p of idx.ds.projects) {
      if (p.ClientID !== a.ClientID || p.ProjectType !== 'Client') continue;
      for (const i of idx.incomeByProject.get(p.ProjectID) || []) {
        if (!(i.StartDate >= a.AcquisitionDate && i.StartDate < windowEnd)) continue;
        lines.push({ acquisition: a, income: i, project: p, windowEnd, revenue: Dec.from(i.AmountPaid), commission: roundCurrency4(Dec.from(i.AmountPaid).mul(Dec.from(a.AcquisitionRate))) });
      }
    }
  }
  return lines;
}

export function acquisitionSummaries(idx, today = todayISO()) {
  const lines = acquisitionLines(idx);
  return idx.ds.acquisitions.map((a) => {
    const mine = lines.filter((l) => l.acquisition.AcquisitionID === a.AcquisitionID);
    const windowEnd = acquisitionWindowEnd(a.AcquisitionDate);
    const status = today < a.AcquisitionDate ? 'Not started' : today < windowEnd ? 'Active' : 'Ended';
    return { acquisition: a, windowEnd, status, eligibleIncome: Dec.sum(mine.map((l) => l.revenue)), earned: Dec.sum(mine.map((l) => l.commission)), lines: mine };
  });
}

// ---------- project / month aggregation ----------
function bucket(projectId, month) {
  return { projectId, month, paid: Z(), costs: Z(), salesFees: Z(), timeValue: Z(), hoursWorked: Z(), hoursBilled: Z(), timeValueMissing: 0, incomeCount: 0, costCount: 0, timeCount: 0, activityCount: 0 };
}

// Aggregates atomic components by project (and optionally month) using each component's attribution date.
export function aggregate(idx, { from = null, to = null, byMonth = false } = {}) {
  const map = new Map();
  const get = (pid, date) => {
    const m = byMonth ? monthOf(date) : null;
    const k = byMonth ? `${pid}|${m}` : pid;
    if (!map.has(k)) map.set(k, bucket(pid, m));
    return map.get(k);
  };
  const ok = (d) => inRange(d, from, to);
  for (const i of idx.ds.income) if (ok(i.StartDate)) { const b = get(i.ProjectID, i.StartDate); b.paid = b.paid.add(i.AmountPaid); b.incomeCount++; }
  for (const c of idx.ds.costs) if (ok(c.StartDate)) { const b = get(c.ProjectID, c.StartDate); b.costs = b.costs.add(c.CostAmount); b.costCount++; }
  for (const t of idx.ds.timeEntries) {
    if (!ok(t.WorkDate)) continue;
    const b = get(t.ProjectID, t.WorkDate);
    b.timeCount++;
    b.hoursWorked = b.hoursWorked.add(dz(t.HoursWorked));
    b.hoursBilled = b.hoursBilled.add(dz(t.HoursBilled));
    const { value } = timeEntryValue(t, idx.people.get(t.PersonID));
    if (value === null) b.timeValueMissing++; else b.timeValue = b.timeValue.add(value);
  }
  for (const a of idx.ds.activities) {
    if (!ok(a.ActivityDate)) continue;
    const b = get(a.ProjectID, a.ActivityDate);
    b.activityCount++;
    b.salesFees = b.salesFees.add(activityEarning(idx, a).earned);
  }
  for (const l of acquisitionLines(idx)) {
    if (!ok(l.income.StartDate)) continue;
    const b = get(l.project.ProjectID, l.income.StartDate);
    b.salesFees = b.salesFees.add(l.commission);
  }
  return [...map.values()];
}

// Derived figures for one bucket (or a total row). isClient controls after-time availability.
export function results(b, isClient) {
  const actualCosts = b.costs.add(b.salesFees);
  const actualResult = b.paid.sub(actualCosts);
  const margin = b.paid.isZero() ? null : actualResult.div(b.paid, 10);
  const afterTime = isClient ? actualResult.sub(b.timeValue) : null;
  return { ...b, actualCosts, actualResult, margin, afterTime };
}

export function sumBuckets(list) {
  const t = bucket(null, null);
  for (const b of list) for (const k of ['paid', 'costs', 'salesFees', 'timeValue', 'hoursWorked', 'hoursBilled']) t[k] = t[k].add(b[k]);
  t.timeValueMissing = list.reduce((n, b) => n + b.timeValueMissing, 0);
  return t;
}

// Project rows with names joined after aggregation. clientOnly -> only ProjectType 'Client' on non-internal clients.
export function projectRows(idx, { from, to, byMonth = false, clientOnly = false, clientId = null, projectId = null } = {}) {
  const rows = [];
  for (const b of aggregate(idx, { from, to, byMonth })) {
    const p = idx.projects.get(b.projectId);
    const c = p ? idx.clients.get(p.ClientID) : null;
    const isClient = p?.ProjectType === 'Client';
    if (clientOnly && (!isClient || c?.IsInternal)) continue;
    if (clientId !== null && p?.ClientID !== clientId) continue;
    if (projectId !== null && b.projectId !== projectId) continue;
    rows.push({ ...results(b, isClient), project: p, client: c, isClient, clientName: clientLabel(c), projectName: p?.ProjectName ?? `Missing project #${b.projectId}`, projectType: p?.ProjectType ?? '—' });
  }
  rows.sort((a, b) => (a.month || '').localeCompare(b.month || '') || a.clientName.localeCompare(b.clientName) || a.projectName.localeCompare(b.projectName) || a.projectId - b.projectId);
  return rows;
}

export function totalRow(rows, isClient = true) {
  const t = results(sumBuckets(rows), isClient);
  if (!isClient) t.afterTime = rows.some((r) => r.isClient) ? Dec.sum(rows.filter((r) => r.afterTime !== null).map((r) => r.afterTime)) : null;
  return t;
}

// ---------- company totals ----------
export function categoryOf(project) {
  if (!project) return 'OTHER';
  if (project.ProjectType === 'Client') return 'CLIENT';
  return CATEGORY_BY_CODE[project.CategoryCode] ? project.CategoryCode : 'OTHER';
}

export function companyTotals(idx, { from = null, to = null } = {}) {
  const cats = Object.fromEntries(COST_CATEGORIES.map((c) => [c.code, Z()]));
  let income = Z(), clientCosts = Z(), recordedCosts = Z();
  const other = new Map();
  for (const i of idx.ds.income) if (inRange(i.StartDate, from, to)) income = income.add(i.AmountPaid);
  for (const c of idx.ds.costs) {
    if (!inRange(c.StartDate, from, to)) continue;
    recordedCosts = recordedCosts.add(c.CostAmount);
    const p = idx.projects.get(c.ProjectID);
    const cat = categoryOf(p);
    if (cat === 'CLIENT') clientCosts = clientCosts.add(c.CostAmount);
    else if (cat === 'OTHER') other.set(c.ProjectID, (other.get(c.ProjectID) || Z()).add(c.CostAmount));
    else cats[cat] = cats[cat].add(c.CostAmount);
  }
  const buckets = aggregate(idx, { from, to });
  const all = sumBuckets(buckets);
  const salesFees = all.salesFees;
  const companyResult = income.sub(recordedCosts).sub(salesFees);
  const ownerSalary = cats.OWNERS_SALARY;
  const otherList = [...other.entries()].map(([pid, amount]) => ({ projectId: pid, label: projectLabel(idx, pid), amount })).sort((a, b) => a.label.localeCompare(b.label));
  return {
    income, clientCosts, categories: cats, otherInternal: otherList, otherInternalTotal: Dec.sum(otherList.map((o) => o.amount)),
    recordedCosts, salesFees, companyResult, ownerSalary,
    beforeOwner: companyResult.add(ownerSalary), netAfterOwner: companyResult,
    hoursWorked: all.hoursWorked, hoursBilled: all.hoursBilled, timeValue: all.timeValue, timeValueMissing: all.timeValueMissing,
    actualCosts: recordedCosts.add(salesFees),
  };
}

// ---------- headline income rates ----------
const monthIndex = (iso) => +iso.slice(0, 4) * 12 + +iso.slice(5, 7) - 1;
const isoOfMonthIndex = (n) => `${Math.floor(n / 12)}-${String((n % 12) + 1).padStart(2, '0')}-01`;

// MRR: paid income dated up to today (within the scope) ÷ calendar months it covers, counting the current month.
// Months run from the scope start, or from the first income month when the scope has no start.
export function monthlyRecurringRevenue(idx, { from = null, to = null, today = todayISO() } = {}) {
  const end = to && to < today ? to : today;
  const inc = idx.ds.income.filter((i) => inRange(i.StartDate, from, end));
  const start = from ?? (inc.length ? inc.reduce((m, i) => (i.StartDate < m ? i.StartDate : m), inc[0].StartDate) : null);
  if (!start || start > end) return null;
  const months = monthIndex(end) - monthIndex(start) + 1;
  const income = Dec.sum(inc.map((i) => Dec.from(i.AmountPaid)));
  return { mrr: income.div(months, 10), income, months, from: start, to: end };
}

// Quarter to date vs the same number of days into the previous quarter, on net (paid income − actual costs, the
// same result as Company Totals). e.g. 30 Oct: 1–30 Oct against 1–30 Jul.
// change = (current − previous) ÷ |previous|, so it reads correctly when either net is negative:
// −100 → −50 is +50% (loss halved), 100 → −50 is −150%, −100 → 50 is +150%. null when the previous net is exactly 0
// (a percentage is undefined); `difference` is always available.
export function quarterToDateComparison(idx, today = todayISO()) {
  const qStartIdx = monthIndex(today) - (monthIndex(today) % 3);
  const qStart = isoOfMonthIndex(qStartIdx), prevStart = isoOfMonthIndex(qStartIdx - 3);
  const elapsed = Math.round((Date.parse(today) - Date.parse(qStart)) / 86400000); // days after the quarter start
  const lastOfPrev = addDays(qStart, -1);
  const sameDay = addDays(prevStart, elapsed);
  const prevEnd = sameDay < lastOfPrev ? sameDay : lastOfPrev; // the previous quarter may be shorter
  const net = (a, b) => companyTotals(idx, { from: a, to: b }).companyResult;
  const current = net(qStart, today), previous = net(prevStart, prevEnd);
  const prevAbs = previous.round(2).abs();
  const q = (iso) => `Q${Math.floor((+iso.slice(5, 7) - 1) / 3) + 1} ${iso.slice(0, 4)}`;
  return {
    current, previous, difference: current.sub(previous),
    change: prevAbs.isZero() ? null : current.sub(previous).div(prevAbs, 10),
    quarter: q(qStart), previousQuarter: q(prevStart), currentRange: [qStart, today], previousRange: [prevStart, prevEnd], days: elapsed + 1,
  };
}

// ---------- sales team ----------
// earned = ordinary activity earnings + acquisition commissions; paidOut = legacy CommissionPaid + payouts.
// Attribution dates: activity -> ActivityDate (earnings and legacy paid), acquisition -> income StartDate, payout -> PayoutDate.
export function salesEvents(idx) {
  const ev = [];
  for (const a of idx.ds.activities) {
    const e = activityEarning(idx, a);
    ev.push({ spId: a.SalespersonID, date: a.ActivityDate, earned: e.earned, paid: e.legacyPaid, credited: e.credited, meeting: a.ActivityType === 'Attended meeting' ? 1 : 0, kind: 'activity', ordinary: e.earned });
  }
  for (const l of acquisitionLines(idx)) ev.push({ spId: l.acquisition.SalespersonID, date: l.income.StartDate, earned: l.commission, paid: Z(), credited: l.revenue, meeting: 0, kind: 'acquisition', acq: l.commission });
  for (const p of idx.ds.payouts) ev.push({ spId: p.SalespersonID, date: p.PayoutDate, earned: Z(), paid: Dec.from(p.AmountPaid), credited: Z(), meeting: 0, kind: 'payout', payout: Dec.from(p.AmountPaid) });
  return ev;
}

export function salesSummary(idx, { from = null, to = null, salespersonId = null } = {}) {
  const ev = salesEvents(idx);
  const rows = [];
  for (const sp of idx.ds.salespeople) {
    if (salespersonId !== null && sp.SalespersonID !== salespersonId) continue;
    const mine = ev.filter((e) => e.spId === sp.SalespersonID);
    const inP = mine.filter((e) => inRange(e.date, from, to));
    const before = from ? mine.filter((e) => e.date < from) : [];
    const s = (list, k) => Dec.sum(list.map((e) => e[k] || Z()));
    const opening = s(before, 'earned').sub(s(before, 'paid'));
    const earned = s(inP, 'earned'), paidOut = s(inP, 'paid');
    rows.push({
      salesperson: sp, spId: sp.SalespersonID, name: salespersonName(idx, sp.SalespersonID),
      meetings: inP.reduce((n, e) => n + e.meeting, 0), defaultFee: sp.MeetingFee, closeRate: sp.CloseRate,
      credited: s(inP, 'credited'), ordinaryEarned: s(inP, 'ordinary'), acquisitionEarned: s(inP, 'acq'),
      earned, legacyPaid: s(inP.filter((e) => e.kind === 'activity'), 'paid'), payouts: s(inP, 'payout'), paidOut,
      owed: earned.sub(paidOut), opening, closing: opening.add(earned).sub(paidOut),
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.spId - b.spId);
  return rows;
}

// Overall balance for one salesperson (all-time), used by the payout form.
export function salespersonBalance(idx, spId) {
  const r = salesSummary(idx, { salespersonId: spId })[0];
  return r ? { earned: r.earned, paidOut: r.paidOut, owed: r.owed } : { earned: Z(), paidOut: Z(), owed: Z() };
}

// Months that have any recorded activity (union of income, work, cost and sales activity dates).
export function activityMonths(ds) {
  const s = new Set();
  for (const i of ds.income) s.add(monthOf(i.StartDate));
  for (const t of ds.timeEntries) s.add(monthOf(t.WorkDate));
  for (const c of ds.costs) s.add(monthOf(c.StartDate));
  for (const a of ds.activities) s.add(monthOf(a.ActivityDate));
  s.delete(null);
  return [...s].sort();
}

// Monthly company trend (income vs actual costs), used by the dashboard chart.
export function monthlyCompany(idx, { from = null, to = null } = {}) {
  const rows = new Map();
  for (const b of aggregate(idx, { from, to, byMonth: true })) {
    if (!rows.has(b.month)) rows.set(b.month, { month: b.month, paid: Z(), actualCosts: Z() });
    const r = rows.get(b.month);
    r.paid = r.paid.add(b.paid); r.actualCosts = r.actualCosts.add(b.costs).add(b.salesFees);
  }
  return [...rows.values()].sort((a, b) => a.month.localeCompare(b.month)).map((r) => ({ ...r, result: r.paid.sub(r.actualCosts) }));
}
