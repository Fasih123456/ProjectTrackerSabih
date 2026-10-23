// Client contracts and their clauses: pure status / term / renewal / totals functions (no storage access).
// A clause runs from StartDate for TermYears + TermMonths; a contract is Active while at least one clause is.
import { Dec } from '../lib/decimal.js';
import { addDays } from '../lib/dates.js';
import { addMonthsClamped, parseIdList } from './recurring.js';

export const contractProjects = (c) => parseIdList(c.ProjectIDs);
const nz = (v) => (v === null || v === undefined ? 0 : v);

// ---------- clauses ----------
export const termMonths = (k) => nz(k.TermYears) * 12 + nz(k.TermMonths);

// End date = start date + term (same day of the month; 31 Jan + 1 month = 28/29 Feb). null = runs until cancelled.
export function clauseEndDate(k) {
  const m = termMonths(k);
  return k.StartDate && m > 0 ? addMonthsClamped(k.StartDate, m) : null;
}

export function termLabel(k) {
  const y = nz(k.TermYears), m = nz(k.TermMonths);
  const part = (n, u) => (n ? `${n} ${u}${n === 1 ? '' : 's'}` : null);
  return [part(y, 'year'), part(m, 'month')].filter(Boolean).join(' ') || 'Until cancelled';
}

// Upcoming (starts later), Active (StartDate..end date inclusive, or no term), Ended.
export function clauseStatus(k, today) {
  if (k.StartDate > today) return 'Upcoming';
  const end = clauseEndDate(k);
  return end && end < today ? 'Ended' : 'Active';
}

// The date by which the client's renewal approval is needed: end date minus the notice period (null if either is missing).
export function renewalDecisionDate(k) {
  const end = clauseEndDate(k);
  if (!end || k.RenewalNoticeCount === null || k.RenewalNoticeCount === undefined || !k.RenewalNoticeUnit) return null;
  const n = k.RenewalNoticeCount;
  return k.RenewalNoticeUnit === 'week' ? addDays(end, -7 * n) : addMonthsClamped(end, -n);
}

// How close a clause's renewal is, from its approval-needed-by date (or its end date when no notice period is set).
// 'urgent': less than a week away or already overdue; 'soon': within the next month; null otherwise or once ended.
export function renewalUrgency(k, today) {
  if (clauseStatus(k, today) !== 'Active') return { level: null, date: null, days: null };
  const date = renewalDecisionDate(k) ?? clauseEndDate(k);
  if (!date) return { level: null, date: null, days: null };
  const days = Math.round((Date.parse(date) - Date.parse(today)) / 86400000);
  const level = days < 7 ? 'urgent' : date <= addMonthsClamped(today, 1) ? 'soon' : null;
  return { level, date, days };
}

// Short status note for an urgent/soon renewal, e.g. "approval overdue" or "approval in 12 days".
export function urgencyNote(u) {
  if (!u.level) return '';
  if (u.days < 0) return 'approval overdue';
  return u.days === 0 ? 'approval due today' : `approval in ${u.days} day${u.days === 1 ? '' : 's'}`;
}

// The most pressing renewal among a contract's clauses.
export function contractUrgency(c, clauses, today) {
  const rank = { urgent: 0, soon: 1 };
  return clausesOf(c, clauses).map((k) => renewalUrgency(k, today)).filter((u) => u.level)
    .sort((a, b) => rank[a.level] - rank[b.level] || a.days - b.days)[0] ?? { level: null, date: null, days: null };
}

export function noticeLabel(k) {
  const n = k.RenewalNoticeCount;
  if (n === null || n === undefined || !k.RenewalNoticeUnit) return '';
  return `${n} ${k.RenewalNoticeUnit}${n === 1 ? '' : 's'}`;
}

// ---------- contracts ----------
export const clausesOf = (c, clauses) => clauses.filter((k) => k.ContractID === c.ContractID);

// Active if any clause is active; otherwise Upcoming if any clause is still to start; Ended when all have ended.
// A contract without clauses is 'No clauses' (it does not hide its projects).
export function contractStatus(c, clauses, today) {
  const st = clausesOf(c, clauses).map((k) => clauseStatus(k, today));
  if (!st.length) return 'No clauses';
  if (st.includes('Active')) return 'Active';
  if (st.includes('Upcoming')) return 'Upcoming';
  return 'Ended';
}

// Sums of the contract's clauses: what the client is charged, what it costs Engineered Plans, and the difference.
export function contractTotals(c, clauses) {
  const z = (v) => (v === null || v === undefined ? Dec.zero() : Dec.from(v));
  const mine = clausesOf(c, clauses);
  const charge = Dec.sum(mine.map((k) => z(k.ChargeToClient)));
  const cost = Dec.sum(mine.map((k) => z(k.CostToEngineeredPlans)));
  return { charge, cost, margin: charge.sub(cost), clauseCount: mine.length };
}

// The contract's period: earliest clause start to latest clause end (to = null when a clause runs until cancelled;
// both null when the contract has no clauses yet, i.e. all time).
export function contractPeriod(c, clauses) {
  const mine = clausesOf(c, clauses).filter((k) => k.StartDate);
  if (!mine.length) return { from: null, to: null };
  const ends = mine.map(clauseEndDate);
  return { from: mine.map((k) => k.StartDate).sort()[0], to: ends.every(Boolean) ? ends.sort().at(-1) : null };
}

// What actually happened on the contract's projects during its period, from Project Income and Project Costs:
// income received, costs recorded and the margin between them (Dec). Records dated outside the period (e.g. under
// an earlier or later contract for the same project) are not counted.
export function contractActuals(c, ds) {
  const pids = new Set(contractProjects(c)), { from, to } = contractPeriod(c, ds.clauses || []);
  const inPeriod = (x) => pids.has(x.ProjectID) && (!from || x.StartDate >= from) && (!to || x.StartDate <= to);
  const income = Dec.sum((ds.income || []).filter(inPeriod).map((x) => Dec.from(x.AmountPaid)));
  const cost = Dec.sum((ds.costs || []).filter(inPeriod).map((x) => Dec.from(x.CostAmount)));
  return { income, cost, margin: income.sub(cost), from, to };
}

// Earliest renewal approval date / end date among the clauses that have not ended (null if none).
export function nextContractDates(c, clauses, today) {
  const live = clausesOf(c, clauses).filter((k) => clauseStatus(k, today) !== 'Ended');
  const min = (xs) => xs.filter(Boolean).sort()[0] ?? null;
  return { decision: min(live.map(renewalDecisionDate)), end: min(live.map(clauseEndDate)), activeCount: live.filter((k) => clauseStatus(k, today) === 'Active').length };
}

// Projects covered by contracts that have all ended. These behave like archived projects (hidden from the Projects
// list and selectors); history is unchanged.
export function contractEndedProjects(ds, today) {
  const clauses = ds.clauses || [];
  const live = new Set(), seen = new Set();
  for (const c of ds.contracts || []) {
    const ended = contractStatus(c, clauses, today) === 'Ended';
    for (const pid of contractProjects(c)) { seen.add(pid); if (!ended) live.add(pid); }
  }
  return new Set([...seen].filter((pid) => !live.has(pid)));
}

// ---------- conversion of version-3 contracts (dates and amounts were on the contract) ----------
// Whole months from start to end when the end falls on the same day of the month (else rounded, and not exact).
function termBetween(start, end) {
  if (!end) return { months: 0, exact: true };
  const diff = (+end.slice(0, 4) * 12 + +end.slice(5, 7)) - (+start.slice(0, 4) * 12 + +start.slice(5, 7));
  for (const m of [diff - 1, diff, diff + 1]) if (m > 0 && addMonthsClamped(start, m) === end) return { months: m, exact: true };
  const days = (Date.parse(end) - Date.parse(start)) / 86400000;
  return { months: Math.max(1, Math.round(days / 30.4375)), exact: false };
}

// Returns { contracts, clauses, nextClauseId }: contracts without the old fields; existing clauses get the contract's
// dates; the contract's own amounts (or a contract without clauses) become a 'Main contract' clause. Contracts
// already in the new shape are returned unchanged.
export function convertV3Contracts(contracts, clauses, nextClauseId = 1, now = new Date().toISOString()) {
  let next = Math.max(nextClauseId, clauses.reduce((m, k) => Math.max(m, k.ClauseID), 0) + 1);
  const outClauses = clauses.map((k) => ({ ...k }));
  const outContracts = [];
  for (const c of contracts) {
    const { StartDate, EndDate, RenewalNoticeCount, RenewalNoticeUnit, RenewalCost, ClientCharge, ...rest } = c;
    if (StartDate === undefined) { outContracts.push(c); continue; }
    outContracts.push(rest);
    const t = termBetween(StartDate, EndDate ?? null);
    const dates = { StartDate, TermYears: t.months >= 12 ? Math.floor(t.months / 12) : null, TermMonths: t.months % 12 || null, RenewalNoticeCount: RenewalNoticeCount ?? null, RenewalNoticeUnit: RenewalNoticeUnit ?? null };
    const mine = outClauses.filter((k) => k.ContractID === c.ContractID);
    for (const k of mine) if (k.StartDate === undefined) Object.assign(k, dates);
    const amount = (v) => v !== null && v !== undefined && Dec.from(v).sign() !== 0;
    if (amount(ClientCharge) || amount(RenewalCost) || !mine.length) {
      outClauses.push({ ClauseID: next++, ContractID: c.ContractID, ClauseTitle: 'Main contract', ClauseDetails: t.exact ? null : `Originally ended ${EndDate}`,
        CostToEngineeredPlans: RenewalCost ?? null, ChargeToClient: ClientCharge ?? null, ...dates, createdAt: now, updatedAt: now, revision: 1 });
    }
  }
  return { contracts: outContracts, clauses: outClauses, nextClauseId: next };
}
