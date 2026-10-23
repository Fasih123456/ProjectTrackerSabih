// Recurring income/costs: pure scheduling functions (no storage access).
// Occurrence n is always computed from the StartDate (never chained), so a rule on the 31st gives
// 31 Jan, 28 Feb, 31 Mar… instead of drifting to the 28th.
import { isForeign, latestRate, applyRate, nativeAmount, AMOUNT_FIELD } from './fx.js';
import { addDays, firstOfMonth, lastOfMonth } from '../lib/dates.js';
import { Dec } from '../lib/decimal.js';

// Salary rules (Schedule 'salary', kept in step with an employee by the database layer): one payment per calendar
// month worked, dated the last day of that month. StartDate = join date, EndDate = leave date (both days worked).
// Every month worked is paid in full, including the join and leave months (no prorating).
export const isSalary = (rule) => rule.Schedule === 'salary';

export function addMonthsClamped(iso, months) {
  const y = +iso.slice(0, 4), m = +iso.slice(5, 7) - 1, d = +iso.slice(8, 10);
  const total = y * 12 + m + months;
  const ny = Math.floor(total / 12), nm = total - ny * 12;
  const last = new Date(Date.UTC(ny, nm + 1, 0)).getUTCDate();
  return `${String(ny).padStart(4, '0')}-${String(nm + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`;
}

export function nthOccurrence(rule, n) {
  if (isSalary(rule)) return lastOfMonth(addMonthsClamped(firstOfMonth(rule.StartDate), n));
  const k = n * rule.IntervalCount;
  switch (rule.IntervalUnit) {
    case 'day': return addDays(rule.StartDate, k);
    case 'week': return addDays(rule.StartDate, 7 * k);
    case 'month': return addMonthsClamped(rule.StartDate, k);
    case 'year': return addMonthsClamped(rule.StartDate, 12 * k);
    default: throw new Error('Unknown frequency unit ' + rule.IntervalUnit);
  }
}

// Look-ahead window: occurrences dated up to LOOKAHEAD_DAYS after today (inclusive) are created.
// horizonFor returns the exclusive bound (today + 15 days).
export const LOOKAHEAD_DAYS = 14;
export const horizonFor = (today) => addDays(today, LOOKAHEAD_DAYS + 1);
export const lastDueDate = (today) => addDays(today, LOOKAHEAD_DAYS);

const MAX_OCCURRENCES = 20000;

// Is the occurrence on `d` after the rule's EndDate? A salary is still paid at the end of the month someone leaves.
// An occurrence dated exactly on the EndDate (other than the first) would start a new period with only its first day
// covered, so it is not due: the term ends there (31 May → 31 Oct monthly gives 5 payments, not 5 plus 1 day).
// A period of a single day (daily rules) is fully covered and stays due.
const pastEnd = (rule, d) => {
  if (!rule.EndDate) return false;
  if (isSalary(rule)) return firstOfMonth(d) > rule.EndDate;
  if (d > rule.EndDate) return true;
  if (d < rule.EndDate || d === rule.StartDate) return false;
  const next = nextAfter(rule, d);
  return !!next && next > addDays(d, 1);
};
// Exclusive bound covering every occurrence up to the EndDate (null when there is no end date).
export const endBound = (rule) => (rule.EndDate ? addDays(isSalary(rule) ? lastOfMonth(rule.EndDate) : rule.EndDate, 1) : null);

// Occurrence dates with after < date < before, also limited by EndDate (inclusive).
export function occurrencesBetween(rule, after, before) {
  const out = [];
  if (!(rule.IntervalCount >= 1)) return out;
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const d = nthOccurrence(rule, n);
    if (d >= before) break;
    if (pastEnd(rule, d)) break;
    if (!after || d > after) out.push(d);
  }
  return out;
}

// Occurrences the generator would create now for this rule.
export const dueOccurrences = (rule, today) => (rule.Archived ? [] : occurrencesBetween(rule, rule.GeneratedThrough, horizonFor(today)));

// Next occurrence after the last one created (or from the start), regardless of the one-month window.
export function nextOccurrence(rule) {
  for (let n = 0; n < MAX_OCCURRENCES; n++) {
    const d = nthOccurrence(rule, n);
    if (pastEnd(rule, d)) return null;
    if (!rule.GeneratedThrough || d > rule.GeneratedThrough) return d;
  }
  return null;
}

// Average amount per calendar month (12 months = 52 weeks = 365 days), for comparing rules with different frequencies.
export function monthlyEquivalent(rule) {
  const a = Dec.from(rule.Amount), n = rule.IntervalCount;
  if (!(n >= 1)) return null;
  switch (rule.IntervalUnit) {
    case 'month': return a.div(n, 10);
    case 'year': return a.div(12 * n, 10);
    case 'week': return a.mul(52).div(12 * n, 10);
    case 'day': return a.mul(365).div(12 * n, 10);
    default: return null;
  }
}

export function frequencyLabel(rule) {
  const n = rule.IntervalCount, u = rule.IntervalUnit;
  if (!(n >= 1) || !u) return '—';
  if (isSalary(rule)) return 'Monthly salary (month end)';
  return n === 1 ? `Every ${u}` : `Every ${n} ${u}s`;
}

// Every occurrence is charged in full (whole periods only; no partial periods, salaries included). The stored
// Proration field is ignored.
const dayNum = (iso) => Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000;
export const daysBetween = (a, b) => dayNum(b) - dayNum(a); // b - a in calendar days

function nextAfter(rule, date) {
  for (let n = 0; n < MAX_OCCURRENCES; n++) { const d = nthOccurrence(rule, n); if (d > date) return d; }
  return null;
}

// { amount (4-dp string), partial, covered, period } for the occurrence on `date`.
// Always the full amount: rules repeat in whole periods, and salaries pay every month worked in full.
export function occurrenceAmount(rule, date) {
  return { amount: Dec.from(rule.Amount).toMoney(), partial: false, covered: null, period: null };
}

// ---------- cost split across projects ----------
// SplitProjects holds the extra project IDs as text ("4,7"); a cost rule then charges its main project and each of
// these an equal share of every occurrence.
export const parseIdList = (text) => [...new Set(String(text ?? '').split(',').map((s) => Number(s.trim())).filter((n) => Number.isSafeInteger(n) && n > 0))];
export const ruleProjects = (rule) => [...new Set([rule.ProjectID, ...(rule.Kind === 'Cost' ? parseIdList(rule.SplitProjects) : [])].filter((x) => x !== null && x !== undefined))];

// Equal shares in whole paisa (or 4 decimals if the total has more); the leftover smallest units go to the first
// shares, so the parts always add up to the total exactly.
export function splitEqually(total, n) {
  const t = Dec.from(total);
  const scale = t.round(2).eq(t) ? 2 : 4;
  const units = t.round(scale).i; // integer count of the smallest unit
  const base = units / BigInt(n), rem = units % BigInt(n);
  return Array.from({ length: n }, (_, k) => new Dec(base + (BigInt(k) < rem ? 1n : 0n), scale));
}

// The ordinary income/cost records created for one occurrence: one per project (usually just one).
// A rule in another currency makes records in that currency, converted at the latest known rate as a provisional
// rate (the background exchange-rate job replaces it with the rate of the record's own date). With no rate known
// yet, the base-currency amount is null and the caller must wait (see foreignRuleBlocked).
export function recordsForOccurrence(rule, date) {
  const out = baseRecordsForOccurrence(rule, date);
  if (!isForeign(rule)) return out;
  const lr = latestRate(rule.Currency);
  for (const { store, record } of out) {
    const field = AMOUNT_FIELD[store];
    Object.assign(record, { Currency: rule.Currency, OriginalAmount: record[field] });
    if (lr) applyRate(store, record, lr.rate, lr.date, 'provisional');
    else Object.assign(record, { [field]: null, FxRate: null, FxDate: null, FxStatus: null });
  }
  return out;
}
// True when a rule in another currency cannot create entries yet because no exchange rate has been loaded.
export const foreignRuleBlocked = (rule) => isForeign(rule) && !latestRate(rule.Currency);

function baseRecordsForOccurrence(rule, date) {
  const a = occurrenceAmount(rule, date);
  const tag = null;
  const join = (...xs) => xs.filter(Boolean).join(' — ') || null;
  if (rule.Kind === 'Income') return [{ store: 'income', record: { ProjectID: rule.ProjectID, StartDate: date, EndDate: null, AmountPaid: a.amount, IncomeNotes: join(rule.Name, rule.Notes, tag), RecurringID: rule.RecurringID } }];
  const pids = ruleProjects(rule);
  const parts = pids.length > 1 ? splitEqually(a.amount, pids.length).map((d) => d.toMoney()) : [a.amount];
  const splitTag = pids.length > 1 ? `Split equally across ${pids.length} projects (total ${Dec.from(a.amount).toFixed(2)})` : null;
  return pids.map((pid, k) => ({ store: 'costs', record: { ProjectID: pid, StartDate: date, EndDate: null, CostItem: rule.Name, CostAmount: parts[k], CostNotes: join(rule.Notes, tag, splitTag), RecurringID: rule.RecurringID } }));
}

// What the rule would have produced for this existing record's date and project (null if that project is not in it).
const expectedFor = (rule, x, store) => recordsForOccurrence(rule, x.StartDate).find((e) => e.store === store && e.record.ProjectID === x.ProjectID) || null;

// Field value for the untouched check; the amount is compared as entered (currency + original amount), so a
// record whose exchange rate was updated later still counts as untouched.
const sameVal = (store, r, k) => (k === '#amount' ? nativeAmount(store, r) : r[k] ?? null);
// x._attached: the record has receipts / invoices attached, so it is treated as edited by hand.
const isUntouched = (rule, x) => {
  if (x._attached) return false;
  const exp = expectedFor(rule, x, x._store);
  return !!exp && SAME_FIELDS[exp.store].every((k) => sameVal(exp.store, x, k) === sameVal(exp.store, exp.record, k));
};

// Entries further ahead than the window (e.g. created when the window was one month) that are still exactly as
// the rule made them are removed, and GeneratedThrough is rewound so they are created again once within the window.
// Hand-edited entries are kept, and their periods are never regenerated. linked: [{...record, _store}].
export function planHorizonTrim(rule, linked, today) {
  const horizon = horizonFor(today);
  // Also the untouched one-day period on the end date that earlier versions created (no longer scheduled). Other entries
  // after the end date are left alone: they were kept on purpose when the rule was edited.
  const deletes = linked.filter((x) => (x.StartDate >= horizon || (x.StartDate === rule.EndDate && pastEnd(rule, x.StartDate))) && isUntouched(rule, x));
  if (!deletes.length) return { deletes, generatedThrough: rule.GeneratedThrough };
  const kept = linked.filter((x) => !deletes.includes(x)).map((x) => x.StartDate);
  const sched = occurrencesBetween(rule, null, addDays(rule.GeneratedThrough, 1));
  const keep = sched.filter((d) => d < horizon || kept.some((k) => k >= d));
  return { deletes, generatedThrough: keep.length ? keep[keep.length - 1] : null };
}

// Dates the rule already scheduled (up to GeneratedThrough) that currently have no income/cost record linked to it,
// e.g. because the entries were deleted to be corrected. Only re-created on explicit request.
// An entry counts for a scheduled period when its date falls anywhere in [occurrence, next occurrence), so entries
// whose dates were edited, or that were created before the start date was changed, are not reported as missing.
// Something is only missing when the rule has fewer linked entries than scheduled occurrences (i.e. entries were deleted).
// A split cost makes one entry per project, so entries are counted in groups of that size, and a period only counts
// as missing when all of its entries are gone (re-creating it adds every share).
export function missingOccurrences(rule, ds) {
  if (!rule.GeneratedThrough) return [];
  const linked = [...ds.income, ...ds.costs].filter((x) => x.RecurringID === rule.RecurringID).map((x) => x.StartDate);
  const sched = occurrencesBetween(rule, null, addDays(rule.GeneratedThrough, 1));
  const deficit = sched.length - Math.ceil(linked.length / Math.max(1, ruleProjects(rule).length));
  if (deficit <= 0) return [];
  const uncovered = sched.filter((d, i) => {
    const next = i + 1 < sched.length ? sched[i + 1] : nthOccurrence(rule, i + 1);
    return !linked.some((x) => x >= d && x < next);
  });
  return uncovered.slice(-deficit); // the most recent uncovered periods
}

const SAME_FIELDS = { income: ['ProjectID', 'StartDate', '#amount', 'IncomeNotes'], costs: ['ProjectID', 'StartDate', 'CostItem', '#amount', 'CostNotes'] };

// After a rule edit: which already-created, untouched records must change? A record counts as untouched when it
// still equals exactly what the OLD rule produced for that date; anything you edited by hand is left alone.
// Returns { updates: [record], deletes: [record], skipped: [record] }.
// Only the end date is applied to existing records (amount or name changes affect
// future occurrences only), so an early leaver's already-created month is corrected without rewriting history.
// A salary's join date works the same way: a month before the new join date is removed, and the first month is
// re-prorated.
export function planRuleAdjustments(oldRule, newRule, records) {
  const out = { updates: [], deletes: [], skipped: [] };
  const target = { ...oldRule, EndDate: newRule.EndDate, ...(isSalary(oldRule) ? { StartDate: newRule.StartDate } : {}) };
  for (const r of records) {
    const store = 'CostID' in r ? 'costs' : 'income';
    const stillDue = !pastEnd(target, r.StartDate) && (!isSalary(target) || r.StartDate >= nthOccurrence(target, 0));
    const before = expectedFor(oldRule, r, store);
    const untouched = !!before && !r._attached && SAME_FIELDS[store].every((k) => sameVal(store, r, k) === sameVal(store, before.record, k));
    const after = expectedFor(target, r, store);
    const needsChange = !stillDue || !after || SAME_FIELDS[store].some((k) => sameVal(store, after.record, k) !== sameVal(store, r, k));
    if (!needsChange) continue;
    if (!untouched) out.skipped.push(r);
    else if (!stillDue) out.deletes.push(r);
    else {
      const u = { ...r, ...after.record };
      // Keep the record's own exchange rate; only the amount in its currency changed (e.g. the rule's amount was edited).
      if (isForeign(u) && r.FxRate) applyRate(store, u, r.FxRate, r.FxDate, r.FxStatus);
      out.updates.push(u);
    }
  }
  return out;
}

// ---------- employee salaries ----------
// An employee (not the owner) with a join date and a salary above zero is paid through one salary rule (PersonID links it), charged
// to the internal cost centre of their SalaryCategory (Team Salaries when blank).
export const SALARY_CATEGORIES = ['TEAM_SALARIES', 'OWNERS_SALARY'];
export const paysSalary = (p) => !p.IsOwner && !!p.JoinDate && p.MonthlyReferenceValue !== null && p.MonthlyReferenceValue !== undefined && Dec.from(p.MonthlyReferenceValue).sign() > 0;

export function salaryProjectId(person, projects) {
  const code = person.SalaryCategory || 'TEAM_SALARIES';
  const ps = projects.filter((p) => p.ProjectType === 'Internal' && p.CategoryCode === code);
  return (ps.find((p) => !p.Archived) || ps[0])?.ProjectID ?? null;
}

export const salaryRuleOf = (person, rules) => rules.find((r) => r.PersonID === person.PersonID && isSalary(r)) || null;

// The salary rule an employee should have now, merged over their existing rule (whose GeneratedThrough and notes
// are kept). Null when there is no rule and none is needed. A rule that is no longer needed is paused (archived).
export function salaryRuleFor(person, existing, projects) {
  if (!paysSalary(person)) return existing && !existing.Archived ? { ...existing, Archived: true } : null;
  return {
    ...(existing || { Notes: null, GeneratedThrough: null }),
    Kind: 'Cost', Name: `Salary: ${person.PersonName}`, ProjectID: salaryProjectId(person, projects), SplitProjects: null,
    Amount: Dec.from(person.MonthlyReferenceValue).toMoney(), StartDate: person.JoinDate, EndDate: person.LeaveDate ?? null,
    IntervalCount: 1, IntervalUnit: 'month', Proration: null, Schedule: 'salary', PersonID: person.PersonID, Archived: person.Archived ? true : null,
  };
}
