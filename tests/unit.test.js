import { test, assert, eq, rejects } from './harness.js';
import { Dec } from '../js/lib/decimal.js';
import { addDays, isValidISODate } from '../js/lib/dates.js';
import { parseNumberInput, parsePercentInput, parseMoneyInput, fmtMoney, fmtMargin, hhmmToDecimal } from '../js/lib/format.js';
import { builder, emptyDs } from '../js/io/fixtures.js';
import { buildIndex, timeEntryValue, activityEarning, acquisitionLines, projectRows, totalRow, companyTotals, salesSummary, acquisitionWindowEnd, aggregate, splitEqually, monthlyRecurringRevenue, quarterToDateComparison, projectLabel, clientLabel, clientNameById } from '../js/calc/calc.js';
import { validateRecord, ctxFromDataset, validateDataset } from '../js/model/validate.js';
import { csvCell, toCSV } from '../js/io/csv.js';
import { REPORTS } from '../js/reports/reports.js';
import { dataQualityIssues } from '../js/calc/quality.js';
import { dueNotifications, recurringCreatedNotifications, mergeNotifications, unreadCount, visibleNotifications } from '../js/calc/notifications.js';
import { contractStatus, renewalDecisionDate, noticeLabel, contractTotals, contractEndedProjects, clauseEndDate, clauseStatus, termLabel, nextContractDates, convertV3Contracts, renewalUrgency, contractUrgency, urgencyNote, contractActuals, contractPeriod } from '../js/calc/contracts.js';

const idxOf = (b) => buildIndex(b.ds);
const proj = (rows, id) => rows.find((r) => r.projectId === id);

// ---------- decimal / dates / parsing ----------
test('decimal: exact money arithmetic and rounding policy (half away from zero)', () => {
  eq(Dec.from('0.1').add('0.2').toString(), '0.3');
  eq(Dec.from('118481.8780').toMoney(), '118481.8780');
  eq(Dec.from('2.00005').round(4).toString(), '2.0001');
  eq(Dec.from('-2.00005').round(4).toString(), '-2.0001');
  eq(Dec.from('320000').div('160').toString(), '2000');
  eq(Dec.from('100000').div('3', 4).toString(), '33333.3333');
  assert(Dec.from('1').div('0') === null, 'divide by zero -> null');
  eq(Dec.from(0.58).mul('2000').toString(), '1160');
});
test('dates: 180-day window independent of DST; validation', () => {
  eq(acquisitionWindowEnd('2026-01-01'), '2026-06-30');
  eq(addDays('2026-03-28', 2), '2026-03-30');
  eq(addDays('2026-10-24', 7), '2026-10-31');
  assert(!isValidISODate('2026-02-30') && isValidISODate('2028-02-29') && !isValidISODate('2026-9-01'));
});
test('input parsing: decimal hours, percents, money', () => {
  eq(parseNumberInput('3.3').value, 3.3);
  eq(parseNumberInput('24.07').value, 24.07);
  eq(hhmmToDecimal('1:30'), 1.5);
  eq(parsePercentInput('5').value, 0.05);
  eq(parsePercentInput('2.5').value, 0.025);
  assert(parsePercentInput('150').error, '150% rejected');
  eq(parseMoneyInput('1,234.5').value, '1234.5000');
  assert(parseMoneyInput('-5').error && parseMoneyInput('1.23456').error);
  eq(fmtMoney('-1234.5'), '($1,234.50)');
  eq(fmtMargin(Dec.from('0.85')), '85.0%');
  eq(fmtMargin(null), '—');
});

// ---------- J2 time ----------
test('J2 time values: defaults, zero override, blank override, decimal hours', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  const a = b.person('A', 320000, 160), z = b.person('Z', 30000, 80);
  const t1 = b.time(p, a, '2026-05-01', 2.5), t2 = b.time(p, z, '2026-05-01', 1), t3 = b.time(p, a, '2026-05-01', 4, 4, 0), t4 = b.time(p, a, '2026-05-01', 3.3);
  const idx = idxOf(b);
  const tv = (id) => { const t = b.ds.timeEntries.find((x) => x.TimeEntryID === id); return timeEntryValue(t, idx.people.get(t.PersonID)); };
  eq(tv(t1).hourly, '2000'); eq(tv(t1).value, '5000');
  eq(tv(t2).hourly, '375');
  eq(tv(t3).hourly, '0'); eq(tv(t3).value, '0');
  eq(tv(t4).value, '6600');
  eq(b.ds.timeEntries.find((x) => x.TimeEntryID === t4).HoursWorked, 3.3);
});

// ---------- J3 actual vs analytical ----------
test('J3 actual vs analytical time value; payout does not reduce result again', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  const a = b.person('A', 320000, 160), s = b.person('S', 0, 160);
  const sp = b.salesperson(s, 0.05, 5000);
  b.income(p, '2026-01-10', 100000); b.cost(p, '2026-01-11', 10000);
  b.activity(p, sp, '2026-01-12', 'Attended meeting');
  b.time(p, a, '2026-01-13', 10);
  let r = proj(projectRows(idxOf(b), { clientOnly: true }), p);
  eq(r.actualCosts, '15000'); eq(r.actualResult, '85000'); eq(r.margin, '0.85'); eq(r.afterTime, '65000'); eq(r.timeValue, '20000');
  b.payout(sp, '2026-02-01', 5000);
  r = proj(projectRows(idxOf(b), { clientOnly: true }), p);
  eq(r.actualResult, '85000');
  eq(companyTotals(idxOf(b)).companyResult, '85000');
  eq(salesSummary(idxOf(b))[0].owed, '0');
});

// ---------- J4 close overrides ----------
test('J4 ordinary close: credited base, base override, zero rate override', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web'), sp = b.salesperson(b.person('S', 0, 160), 0.05, 0);
  const a1 = b.activity(p, sp, '2026-01-01', 'Close', { credited: 40000 });
  const a2 = b.activity(p, sp, '2026-01-01', 'Close', { credited: 40000, base: 30000 });
  const a3 = b.activity(p, sp, '2026-01-01', 'Close', { credited: 40000, rate: 0 });
  const a4 = b.activity(p, sp, '2026-01-01', 'Close', {});
  const idx = idxOf(b);
  const e = (id) => activityEarning(idx, b.ds.activities.find((x) => x.ActivityID === id)).earned;
  eq(e(a1), '2000'); eq(e(a2), '1500'); eq(e(a3), '0'); eq(e(a4), '0');
});

// ---------- J5 meetings and payouts ----------
test('J5 meetings, payouts, legacy paid once, salesperson with no activity', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  const sp = b.salesperson(b.person('S', 0, 160), 0.05, 2000), idle = b.salesperson(b.person('Idle', 0, 160), 0.1, 1000);
  for (let i = 0; i < 3; i++) b.activity(p, sp, '2026-01-0' + (i + 1), 'Attended meeting');
  b.payout(sp, '2026-02-01', 2500);
  let rows = salesSummary(idxOf(b));
  const r = rows.find((x) => x.spId === sp);
  eq(r.meetings, 3); eq(r.earned, '6000'); eq(r.paidOut, '2500'); eq(r.owed, '3500');
  const i = rows.find((x) => x.spId === idle);
  assert(i && i.earned.isZero() && i.owed.isZero() && i.meetings === 0, 'idle salesperson listed with zeros');
  b.activity(p, sp, '2026-01-09', 'Attended meeting', { paid: 1000 });
  rows = salesSummary(idxOf(b));
  const r2 = rows.find((x) => x.spId === sp);
  eq(r2.earned, '8000'); eq(r2.paidOut, '3500'); eq(r2.owed, '4500');
  // overpayment stays negative
  b.payout(sp, '2026-03-01', 10000);
  eq(salesSummary(idxOf(b)).find((x) => x.spId === sp).owed, '-5500');
});

// ---------- J6 acquisition ----------
test('J6 acquisition: 10% on multiple projects, window boundaries, later project', () => {
  const b = builder();
  const c = b.client('Acquired'), p1 = b.project(c, 'One'), p2 = b.project(c, 'Two');
  const sp = b.salesperson(b.person('S', 0, 160), 0.05, 0);
  b.acquisition(c, sp, '2026-01-01', 0.1);
  b.income(p1, '2026-01-15', 40000); b.income(p2, '2026-02-01', 50000);
  b.income(p1, '2026-01-01', 1000);            // acquisition day included
  b.income(p1, addDays('2026-01-01', 179), 2000); // +179 included
  b.income(p1, addDays('2026-01-01', 180), 3000); // +180 excluded
  b.income(p1, '2025-12-31', 4000);            // before excluded
  const later = b.project(c, 'Added later'); b.income(later, '2026-03-01', 10000);
  const lines = acquisitionLines(idxOf(b));
  const byAmt = (a) => lines.find((l) => l.revenue.eq(a));
  eq(byAmt(40000).commission, '4000'); eq(byAmt(50000).commission, '5000');
  assert(byAmt(1000) && byAmt(2000), 'boundary days included');
  assert(!byAmt(3000) && !byAmt(4000), 'excluded days');
  eq(byAmt(10000).commission, '1000');
  eq(lines[0].windowEnd, '2026-06-30');
  const s = salesSummary(idxOf(b))[0];
  eq(s.earned, '10300'); eq(s.credited, '103000');
});
test('J6 acquisition validation: internal client rejected, duplicate rejected, rounding to 4 dp per line', () => {
  const b = builder();
  const c = b.client('Acquired'), p = b.project(c, 'One');
  const sp = b.salesperson(b.person('S', 0, 160), 0.05, 0);
  b.acquisition(c, sp, '2026-01-01', 0.1);
  const ctx = ctxFromDataset(b.ds);
  const e1 = validateRecord('acquisitions', { AcquisitionID: null, ClientID: 1, SalespersonID: sp, AcquisitionDate: '2026-01-01', AcquisitionRate: 0.1, AcquisitionNotes: null }, ctx);
  assert(/internal/i.test(e1.ClientID || ''), 'internal rejected: ' + JSON.stringify(e1));
  const e2 = validateRecord('acquisitions', { AcquisitionID: null, ClientID: c, SalespersonID: sp, AcquisitionDate: '2026-01-01', AcquisitionRate: 0.1, AcquisitionNotes: null }, ctx);
  assert(/already/i.test(e2.ClientID || ''), 'duplicate rejected');
  b.ds.acquisitions[0].AcquisitionRate = 0.033;
  b.income(p, '2026-01-02', '118481.8780');
  eq(acquisitionLines(idxOf(b))[0].commission.toMoney(), '3909.9020'); // 3909.901974 -> 3909.9020
});

// ---------- J7 no duplicated close ----------
test('J7 acquired client: ordinary close suppressed for any salesperson/date, meetings still earn', () => {
  const b = builder();
  const c = b.client('Acquired'), p = b.project(c, 'One');
  const sp1 = b.salesperson(b.person('S1', 0, 160), 0.05, 2000), sp2 = b.salesperson(b.person('S2', 0, 160), 0.05, 1500);
  b.acquisition(c, sp1, '2026-01-01', 0.1);
  b.income(p, '2026-01-10', 40000);
  const cl = b.activity(p, sp2, '2027-05-01', 'Close', { credited: 40000 });
  b.activity(p, sp2, '2026-01-05', 'Attended meeting');
  const idx = idxOf(b);
  const e = activityEarning(idx, b.ds.activities.find((a) => a.ActivityID === cl));
  assert(e.suppressed && e.earned.isZero() && e.credited.isZero(), 'close suppressed');
  const rows = salesSummary(idx);
  const s1 = rows.find((r) => r.spId === sp1), s2 = rows.find((r) => r.spId === sp2);
  eq(s1.earned, '4000'); eq(s1.credited, '40000');
  eq(s2.earned, '1500'); eq(s2.credited, '0');
});

// ---------- one expense split across projects ----------
test('cost split: equal shares that add up to the total exactly', () => {
  const s = (t, n) => splitEqually(t, n).map((d) => d.toMoney());
  eq(s('9000.0000', 3), ['3000.0000', '3000.0000', '3000.0000']);
  eq(s('10000.0000', 3), ['3333.3400', '3333.3300', '3333.3300']);
  eq(s('0.0100', 3), ['0.0100', '0.0000', '0.0000']);
  eq(s('100.0050', 2), ['50.0025', '50.0025']); // more than 2 decimals: split at 4 so nothing is lost
  eq(s('5527.3200', 1), ['5527.3200']);
  for (const [t, n] of [['10000', 7], ['5527.32', 4], ['1', 6], ['118481.878', 9]]) eq(Dec.sum(splitEqually(t, n)).toMoney(), Dec.from(t).toMoney());
  const b = builder();
  const c = b.client('Alpha'), p1 = b.project(c, 'Web'), p2 = b.project(c, 'App');
  splitEqually('10000', 2).forEach((part, k) => b.cost([p1, p2][k], '2026-07-01', part.toMoney()));
  const rows = projectRows(idxOf(b), {});
  eq(proj(rows, p1).costs.toMoney(), '5000.0000'); eq(proj(rows, p2).costs.toMoney(), '5000.0000');
});

// ---------- dashboard: MRR and quarter-to-date performance ----------
test('MRR: paid income up to today ÷ months covered; quarter to date vs same days of last quarter', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  b.income(p, '2026-07-03', 10); b.income(p, '2026-07-20', 1000); b.income(p, '2026-08-10', 2000);
  b.income(p, '2026-10-02', 15); b.income(p, '2026-10-07', 5000); // the last one is after "today"
  const idx = idxOf(b), today = '2026-10-06';
  const all = monthlyRecurringRevenue(idx, { today });
  eq(all.months, 4, 'Jul..Oct inclusive'); eq(all.income.toMoney(), '3025.0000'); eq(all.mrr.round(2).toFixed(2), '756.25');
  eq(monthlyRecurringRevenue(idx, { from: '2026-01-01', to: '2026-12-31', today }).months, 10, 'this-year scope counts from January');
  eq(monthlyRecurringRevenue(idx, { from: '2026-08-01', to: '2026-08-31', today }).mrr.toMoney(), '2000.0000', 'one past month');
  eq(monthlyRecurringRevenue(idx, { from: '2027-01-01', to: null, today }), null, 'scope entirely in the future');
  const q = quarterToDateComparison(idx, today);
  eq(q.quarter, 'Q4 2026'); eq(q.previousQuarter, 'Q3 2026'); eq(q.previousRange.join(), '2026-07-01,2026-07-06'); eq(q.days, 6);
  eq(q.current.toMoney(), '15.0000'); eq(q.previous.toMoney(), '10.0000'); eq(q.change.mul(100).round(1).toFixed(1), '50.0', '+50%');
  eq(quarterToDateComparison(idx, '2026-07-02').change, null, 'nothing in the first 2 days of Q2 to compare with');
  eq(quarterToDateComparison(idx, '2026-12-31').previousRange.join(), '2026-07-01,2026-09-30', 'Q4 (92 days) vs whole shorter Q3');
  eq(quarterToDateComparison(idx, '2026-02-15').previousRange.join(), '2025-10-01,2025-11-15', 'previous year’s Q4');
  // net = income − costs; negatives compared against the size of last quarter's net
  const net = (prevInc, prevCost, curInc, curCost) => {
    const n = builder(); const nc = n.client('N'), np = n.project(nc, 'P');
    if (prevInc) n.income(np, '2026-07-05', prevInc); if (prevCost) n.cost(np, '2026-07-06', prevCost);
    if (curInc) n.income(np, '2026-10-05', curInc); if (curCost) n.cost(np, '2026-10-06', curCost);
    n.cost(np, '2026-07-20', 99999); // after day 9 of Q3: outside the comparison window
    return quarterToDateComparison(idxOf(n), '2026-10-09');
  };
  const pct = (r) => (r.change === null ? null : r.change.mul(100).round(1).toFixed(1));
  eq(pct(net(1000, 900, 1000, 850)), '50.0', 'profit 100 -> 150 = +50%');
  eq(pct(net(1000, 1100, 1000, 1050)), '50.0', 'loss 100 -> loss 50 = +50% (better)');
  eq(pct(net(1000, 1100, 1000, 1200)), '-100.0', 'loss 100 -> loss 200 = −100% (worse)');
  eq(pct(net(1000, 900, 1000, 1050)), '-150.0', 'profit 100 -> loss 50 = −150%');
  eq(pct(net(1000, 1100, 1000, 950)), '150.0', 'loss 100 -> profit 50 = +150%');
  const zero = net(0, 0, 5000, 1000);
  eq(zero.change, null, 'no base for a %'); eq(zero.difference.toMoney(), '4000.0000'); eq(zero.current.toMoney(), '4000.0000');
});

// ---------- client details ----------
test('clients: "{name} - {company}" label everywhere, contact details validated', () => {
  const b = builder();
  const c = b.client('Jordan'), p = b.project(c, 'example.com');
  let idx = idxOf(b);
  eq(projectLabel(idx, p), 'Jordan / example.com', 'no company: name only');
  Object.assign(b.ds.clients.find((x) => x.ClientID === c), { CompanyName: 'Example Co', Website: 'example.com', Phone: '+1 416 555 0100', Email: 'jordan@example.com' });
  idx = idxOf(b);
  eq(clientLabel(idx.clients.get(c)), 'Jordan - Example Co'); eq(clientNameById(idx, c), 'Jordan - Example Co'); eq(clientNameById(idx, 999), '—');
  eq(projectLabel(idx, p), 'Jordan - Example Co / example.com');
  const ctx = ctxFromDataset(b.ds), base = { ClientID: null, ClientName: 'X', IsInternal: false };
  eq(Object.keys(validateRecord('clients', { ...base, Email: 'not-an-email' }, ctx)).join(), 'Email');
  eq(Object.keys(validateRecord('clients', { ...base, Website: 'no spaces allowed.com x' }, ctx)).join(), 'Website');
  eq(Object.keys(validateRecord('clients', { ...base, Email: 'a@b.co', Website: 'https://b.co/path', Phone: '0300-1234567', CompanyName: 'B' }, ctx)).join(), '', 'valid details');
  eq(Object.keys(validateRecord('clients', { ...base, Email: null, Website: ' ' }, ctx)).join(), '', 'details are optional');
  eq(validateDataset({ ...b.ds }).errors.join('|'), '', 'contact fields are part of the schema');
});

// ---------- contracts ----------
test('contract clauses: end date from start + term, status, renewal approval date; contract active if any clause is', () => {
  const today = '2026-10-09';
  const k = (o) => ({ ClauseID: 1, ContractID: 1, ClauseTitle: 'Hosting', StartDate: '2026-04-07', TermYears: 2, TermMonths: null, RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', ChargeToClient: '60000.0000', CostToEngineeredPlans: '20000.0000', ...o });
  eq(clauseEndDate(k({})), '2028-04-07', '2 years after 7 Apr 2026');
  eq(clauseEndDate(k({ TermYears: 1, TermMonths: 6 })), '2027-10-07'); eq(clauseEndDate(k({ TermYears: null, TermMonths: 18 })), '2027-10-07');
  eq(clauseEndDate(k({ StartDate: '2026-01-31', TermYears: null, TermMonths: 1 })), '2026-02-28', 'month-end clamped');
  eq(clauseEndDate(k({ TermYears: null })), null, 'no term = until cancelled'); eq(clauseEndDate(k({ TermYears: 0, TermMonths: 0 })), null);
  eq(termLabel(k({})), '2 years'); eq(termLabel(k({ TermYears: 1, TermMonths: 1 })), '1 year 1 month'); eq(termLabel(k({ TermYears: null })), 'Until cancelled');
  eq(clauseStatus(k({}), today), 'Active'); eq(clauseStatus(k({ StartDate: '2026-11-01' }), today), 'Upcoming');
  eq(clauseStatus(k({ StartDate: '2025-10-09', TermYears: 1 }), today), 'Active', 'end date inclusive'); eq(clauseStatus(k({ StartDate: '2025-10-08', TermYears: 1 }), today), 'Ended');
  eq(clauseStatus(k({ StartDate: '2020-01-01', TermYears: null }), today), 'Active', 'until cancelled');
  eq(renewalDecisionDate(k({})), '2028-03-07', '1 month before the end'); eq(renewalDecisionDate(k({ RenewalNoticeCount: 4, RenewalNoticeUnit: 'week' })), '2028-03-10');
  eq(renewalDecisionDate(k({ TermYears: null })), null); eq(renewalDecisionDate(k({ RenewalNoticeCount: null, RenewalNoticeUnit: null })), null);
  eq(noticeLabel(k({})), '1 month'); eq(noticeLabel(k({ RenewalNoticeCount: 3, RenewalNoticeUnit: 'week' })), '3 weeks');
  const c = { ContractID: 1 }, ended = k({ ClauseID: 2, StartDate: '2024-01-01', TermYears: 1 }), upcoming = k({ ClauseID: 3, StartDate: '2027-01-01' });
  eq(contractStatus(c, [ended, k({ ClauseID: 4 })], today), 'Active', 'one active clause is enough');
  eq(contractStatus(c, [ended, upcoming], today), 'Upcoming'); eq(contractStatus(c, [ended], today), 'Ended'); eq(contractStatus(c, [], today), 'No clauses');
  const t = contractTotals(c, [k({}), k({ ClauseID: 5, ChargeToClient: null, CostToEngineeredPlans: '500.0000' }), k({ ClauseID: 6, ContractID: 9 })]);
  eq(t.charge.toMoney(), '60000.0000'); eq(t.cost.toMoney(), '20500.0000'); eq(t.margin.toMoney(), '39500.0000'); eq(t.clauseCount, 2);
  const nx = nextContractDates(c, [ended, k({ ClauseID: 7 }), k({ ClauseID: 8, TermYears: 1 })], today);
  eq(nx.end, '2027-04-07'); eq(nx.decision, '2027-03-07'); eq(nx.activeCount, 2);
  // projects: 7 has an ended + an active contract (visible); 8 only ended (hidden); 9 upcoming; 10 contract without clauses
  const ds = { contracts: [{ ContractID: 1, ProjectIDs: '7,8' }, { ContractID: 2, ProjectIDs: '7' }, { ContractID: 3, ProjectIDs: '9' }, { ContractID: 4, ProjectIDs: '10' }],
    clauses: [{ ...ended, ContractID: 1 }, k({ ClauseID: 9, ContractID: 2 }), { ...upcoming, ContractID: 3 }] };
  eq([...contractEndedProjects(ds, today)].join(), '8');
});

test('contract renewals: yellow within a month, red within a week or overdue', () => {
  const today = '2026-10-09';
  // A 1-year clause with 7 weeks' notice whose approval date is `approvalBy` (end = approvalBy + 49 days, start = end − 1 year).
  const k = (approvalBy) => ({ ClauseID: 1, ContractID: 1, StartDate: addMonthsClamped(addDays(approvalBy, 49), -12), TermYears: 1, TermMonths: null, RenewalNoticeCount: 7, RenewalNoticeUnit: 'week' });
  const lvl = (approvalBy) => renewalUrgency(k(approvalBy), today);
  eq(renewalDecisionDate(k('2026-10-20')), '2026-10-20', 'helper sanity');
  eq(lvl('2026-12-01').level, null, 'more than a month away');
  eq(lvl('2026-11-09').level, 'soon', 'exactly a month away'); eq(lvl('2026-10-17').level, 'soon', '8 days');
  eq(lvl('2026-10-16').level, 'soon', '7 days is a week, not less'); eq(lvl('2026-10-15').level, 'urgent', '6 days');
  eq(lvl('2026-10-09').level, 'urgent', 'today'); eq(urgencyNote(lvl('2026-10-09')), 'approval due today');
  eq(lvl('2026-09-30').level, 'urgent', 'overdue while still active'); eq(urgencyNote(lvl('2026-09-30')), 'approval overdue');
  eq(urgencyNote(lvl('2026-10-21')), 'approval in 12 days');
  // no notice period: the end date itself is the renewal date; ended or open-ended clauses are never highlighted
  eq(renewalUrgency({ StartDate: '2025-10-20', TermYears: 1, TermMonths: null, RenewalNoticeCount: null, RenewalNoticeUnit: null }, today).level, 'soon', 'end date in 11 days');
  eq(renewalUrgency({ StartDate: '2025-10-01', TermYears: 1, TermMonths: null, RenewalNoticeCount: 1, RenewalNoticeUnit: 'month' }, today).level, null, 'already ended');
  eq(renewalUrgency({ StartDate: '2020-01-01', TermYears: null, TermMonths: null, RenewalNoticeCount: 1, RenewalNoticeUnit: 'month' }, today).level, null, 'until cancelled');
  // contract: the most pressing clause wins
  const cl = [{ ...k('2026-10-25'), ClauseID: 1 }, { ...k('2026-10-12'), ClauseID: 2 }, { ...k('2027-06-01'), ClauseID: 3 }];
  eq(contractUrgency({ ContractID: 1 }, cl, today).level, 'urgent'); eq(contractUrgency({ ContractID: 1 }, cl.slice(0, 1), today).level, 'soon');
  eq(contractUrgency({ ContractID: 1 }, [cl[2]], today).level, null);
});

test('notifications: renewal in 2 weeks, year end on 24 Jan, recurring ended / added; each only once', () => {
  const b = builder();
  const c = b.client('Jordan'), p = b.project(c, 'Site');
  b.ds.contracts.push({ ContractID: 1, ClientID: c, ContractName: 'Hosting', ContractNotes: null, ProjectIDs: String(p) });
  // approval needed by = end − 1 month; end = start + 1 year
  const clause = (id, approvalBy, o = {}) => ({ ClauseID: id, ContractID: 1, ClauseTitle: `Clause ${id}`, ClauseDetails: null, CostToEngineeredPlans: null, ChargeToClient: null, StartDate: addMonthsClamped(addMonthsClamped(approvalBy, 1), -12), TermYears: 1, TermMonths: null, RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', ...o });
  b.ds.clauses.push(clause(1, '2026-10-23'), clause(2, '2026-10-24'), clause(3, '2026-10-01'), clause(4, '2026-08-01'));
  b.ds.recurring.push({ RecurringID: 5, Kind: 'Cost', ProjectID: p, Name: 'Aisha salary', Amount: '30000.0000', StartDate: '2026-01-01', EndDate: '2026-10-01', IntervalCount: 1, IntervalUnit: 'month', Notes: null },
    { RecurringID: 6, Kind: 'Cost', ProjectID: p, Name: 'Old tool', Amount: '1.0000', StartDate: '2025-01-01', EndDate: '2026-08-01', IntervalCount: 1, IntervalUnit: 'month', Notes: null },
    { RecurringID: 7, Kind: 'Income', ProjectID: p, Name: 'Retainer', Amount: '1.0000', StartDate: '2025-01-01', EndDate: '2026-10-09', IntervalCount: 1, IntervalUnit: 'month', Notes: null });
  const due = dueNotifications(b.ds, '2026-10-09');
  const keys = due.map((n) => n.key).sort();
  eq(keys.join(), 'approval:1:2026-10-23,approval:3:2026-10-01,recurring-ended:5:2026-10-01',
    '14 days ahead yes, 15 no; overdue up to a month; ended in the last month (not today, not 2 months ago)');
  const a1 = due.find((n) => n.key === 'approval:1:2026-10-23');
  eq(a1.title, 'Renewal approval due within 2 weeks'); assert(a1.body.includes('Jordan / Hosting — Clause 1') && a1.body.includes('2026-10-23'), a1.body); eq(a1.link, '#/clauses?contract=1');
  eq(due.find((n) => n.key.startsWith('approval:3')).title, 'Renewal approval overdue');
  assert(due.find((n) => n.type === 'recurring-ended').title === 'Recurring cost ended: Aisha salary');
  // year end: from 24 January, once per year
  eq(dueNotifications(b.ds, '2027-01-23').filter((n) => n.type === 'year-end').length, 0);
  eq(dueNotifications(b.ds, '2027-01-24').filter((n) => n.type === 'year-end').map((n) => n.key).join(), 'year-end:2027');
  eq(dueNotifications(b.ds, '2027-01-28').filter((n) => n.type === 'year-end').length, 1, 'still shown if first opened later that week');
  eq(dueNotifications(b.ds, '2027-02-01').filter((n) => n.type === 'year-end').length, 0);
  // recurring entries added: one notification per rule per run
  const made = recurringCreatedNotifications([{ ruleId: 5, name: 'Aisha salary', kind: 'Cost', projectIds: [p], ids: [41, 42], dates: ['2026-10-01', '2026-11-01'], amounts: ['30000.0000', '30000.0000'] }, { ruleId: 6, name: 'x', kind: 'Cost', projectIds: [p], ids: [], dates: [], amounts: [] }], b.ds);
  eq(made.length, 1); eq(made[0].key, 'recurring-created:5:41'); eq(made[0].title, 'Recurring cost added: Aisha salary');
  assert(made[0].body.includes('2 entries totalling $60,000.00') && made[0].body.includes('2026-10-01 … 2026-11-01'), made[0].body);
  // merge: new keys only, unread, newest first, null when nothing new
  const first = mergeNotifications([], [...due, ...made], '2026-10-09T10:00:00.000Z');
  eq(first.length, 4); assert(first.every((n) => !n.read && !n.dismissed && n.createdAt === '2026-10-09T10:00:00.000Z'));
  eq(mergeNotifications(first, due, 'later'), null, 'same events never notify twice');
  const read = first.map((n) => ({ ...n, read: true }));
  const second = mergeNotifications(read, [{ key: 'year-end:2027', type: 'year-end', title: 't', body: 'b', link: '#/reports' }], 'x');
  eq(second[0].key, 'year-end:2027'); eq(unreadCount(second), 1); eq(visibleNotifications([{ ...second[0], dismissed: true }]).length, 0);
});

test('contracts: version-3 contracts (dates/amounts on the contract) convert to clauses', () => {
  const now = '2026-10-09T00:00:00.000Z';
  const v3 = (o) => ({ ContractID: 1, ClientID: 2, ContractName: 'Hosting', StartDate: '2026-04-07', EndDate: '2028-04-07', RenewalNoticeCount: 1, RenewalNoticeUnit: 'month', RenewalCost: null, ClientCharge: null, ContractNotes: 'n', ProjectIDs: '5', revision: 3, ...o });
  // the user's contract: no amounts, no clauses -> one 'Main contract' clause carrying the dates (2 years exactly)
  let out = convertV3Contracts([v3({})], [], 1, now);
  eq(Object.keys(out.contracts[0]).sort().join(), 'ClientID,ContractID,ContractName,ContractNotes,ProjectIDs,revision');
  eq(out.clauses.length, 1); const m = out.clauses[0];
  eq([m.ClauseID, m.ClauseTitle, m.StartDate, m.TermYears, m.TermMonths, m.RenewalNoticeCount, m.RenewalNoticeUnit, m.ClauseDetails].join(), '1,Main contract,2026-04-07,2,,1,month,');
  eq(clauseEndDate(m), '2028-04-07', 'same end date as before'); eq(out.nextClauseId, 2);
  // existing clauses get the contract dates; amounts become an extra clause; an odd end date is rounded and noted
  out = convertV3Contracts([v3({ EndDate: '2027-01-31', ClientCharge: '60000.0000' })], [{ ClauseID: 4, ContractID: 1, ClauseTitle: 'SSL', ClauseDetails: null, CostToEngineeredPlans: '1000.0000', ChargeToClient: '5000.0000' }], 3, now);
  eq(out.clauses.length, 2); eq(out.clauses[0].StartDate, '2026-04-07'); eq(out.clauses[0].TermMonths, 10);
  eq(out.clauses[1].ClauseID, 5); eq(out.clauses[1].ChargeToClient, '60000.0000'); eq(out.clauses[1].ClauseDetails, 'Originally ended 2027-01-31');
  // open-ended contract with clauses but no amounts: no extra clause; already-converted contracts are untouched
  out = convertV3Contracts([v3({ EndDate: null }), { ContractID: 2, ClientID: 2, ContractName: 'New', ContractNotes: null, ProjectIDs: null }], [{ ClauseID: 1, ContractID: 1, ClauseTitle: 'x', ClauseDetails: null, CostToEngineeredPlans: null, ChargeToClient: null }], 1, now);
  eq(out.clauses.length, 1); eq(out.clauses[0].TermYears, null); eq(out.clauses[0].TermMonths, null); eq(out.contracts[1].ContractName, 'New');
  const v = validateDataset({ ...emptyDs(), clients: [{ ClientID: 2, ClientName: 'C', IsInternal: false }], projects: [], contracts: convertV3Contracts([v3({ ProjectIDs: null })], [], 1, now).contracts, clauses: convertV3Contracts([v3({ ProjectIDs: null })], [], 1, now).clauses });
  eq(v.errors.join('|'), '', 'converted records are valid');
});

// ---------- J8 no proration ----------
test('J8 no proration; cost-only and time-only months retained', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web'), a = b.person('A', 320000, 160);
  b.cost(p, '2026-01-20', 9000, 'Two-month licence', '2026-02-19');
  b.time(p, a, '2026-03-05', 1);
  const rows = projectRows(idxOf(b), { byMonth: true, clientOnly: true });
  eq(rows.length, 2);
  eq(rows[0].month, '2026-01'); eq(rows[0].costs, '9000');
  eq(rows[1].month, '2026-03'); eq(rows[1].timeValue, '2000');
  assert(!rows.some((r) => r.month === '2026-02'), 'EndDate creates no February row');
});

// ---------- J9 company categories ----------
test('J9 company totals by category; reference values create no expense', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  b.person('Owner', 999999, 160);
  const sp = b.salesperson(b.person('S', 0, 160), 0.05, 5000);
  b.income(p, '2026-01-01', 100000); b.cost(p, '2026-01-02', 10000);
  b.cost(4, '2026-01-03', 12000); b.cost(3, '2026-01-03', 5000); b.cost(1, '2026-01-03', 3000); // operations, equipment, bank fees = 20,000
  b.cost(5, '2026-01-04', 30000); b.cost(6, '2026-01-05', 10000);
  b.activity(p, sp, '2026-01-06', 'Attended meeting');
  const t = companyTotals(idxOf(b));
  eq(t.beforeOwner, '35000'); eq(t.netAfterOwner, '25000'); eq(t.categories.BANK_FEES, '3000'); eq(t.clientCosts, '10000'); eq(t.salesFees, '5000');
  // an extra internal project counts once under Other Internal Costs
  const extra = b.project(1, 'Training', 'Internal'); b.cost(extra, '2026-01-07', 1000);
  const t2 = companyTotals(idxOf(b));
  eq(t2.otherInternalTotal, '1000'); eq(t2.netAfterOwner, '24000');
  // renaming a cost centre does not move its costs
  b.ds.projects.find((x) => x.ProjectID === 1).ProjectName = 'Banking charges';
  eq(companyTotals(idxOf(b)).categories.BANK_FEES, '3000');
});

// ---------- J10 zero / negative / totals ----------
test('J10 zero income margin unavailable, losses negative, weighted total margin, empty data, duplicate names', () => {
  const b = builder();
  const c1 = b.client('Same'), c2 = b.client('Same');
  const p1 = b.project(c1, 'Proj'), p2 = b.project(c2, 'Proj');
  b.income(p1, '2026-01-01', 100000); b.cost(p1, '2026-01-01', 10000);
  b.income(p2, '2026-01-01', 10000); b.cost(p2, '2026-01-01', 20000);
  const p3 = b.project(c1, 'Zero'); b.cost(p3, '2026-01-01', 500);
  const rows = projectRows(idxOf(b), { clientOnly: true });
  eq(rows.length, 3, 'duplicate names not merged');
  eq(proj(rows, p2).actualResult, '-10000');
  assert(proj(rows, p3).margin === null, 'zero income -> null margin');
  const t = totalRow(rows);
  eq(t.actualResult, '79500'); eq(t.margin.round(6), Dec.from('79500').div('110000', 6));
  const empty = buildIndex(emptyDs());
  const ct = companyTotals(empty);
  eq(ct.companyResult, '0'); eq(totalRow(projectRows(empty)).paid, '0'); assert(totalRow(projectRows(empty)).margin === null);
  for (const r of REPORTS) { const out = r.build(empty, {}); assert(out.tables.length, r.id); }
  // internal project after-time is unavailable, not zero
  const internalRows = projectRows(idxOf(b), {});
  assert(internalRows.every((r) => r.isClient || r.afterTime === null));
});

// ---------- validation ----------
test('validation: dates, rates, blanks, payouts, type consistency, edits of imported anomalies', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web');
  const ctx = ctxFromDataset(b.ds);
  const inc = { IncomeID: null, ProjectID: p, StartDate: '2026-02-01', EndDate: '2026-01-01', AmountPaid: '10.0000', IncomeNotes: null };
  assert(validateRecord('income', inc, ctx).EndDate, 'end before start rejected');
  assert(!Object.keys(validateRecord('income', { ...inc, EndDate: null }, ctx)).length, 'blank end ok');
  assert(validateRecord('payouts', { PayoutID: null, SalespersonID: 1, PayoutDate: '2026-01-01', AmountPaid: '0.0000', PayoutNotes: null }, ctx).AmountPaid, 'zero payout rejected');
  assert(validateRecord('projects', { ProjectID: null, ClientID: 1, ProjectName: 'X', ProjectType: 'Client', CategoryCode: null, Archived: null }, ctx).ProjectType, 'client project under internal client rejected');
  assert(validateRecord('people', { PersonID: null, PersonName: 'P', MonthlyReferenceValue: '100.0000', ReferenceHours: 0, RateNotes: null, BankName: null, AccountName: null, IBAN: null, Archived: null }, ctx).ReferenceHours, 'zero ref hours rejected');
  // imported anomaly: editing the notes of an income with EndDate < StartDate is allowed; changing dates re-validates
  const orig = { ...inc, IncomeID: 9 };
  assert(!Object.keys(validateRecord('income', { ...orig, IncomeNotes: 'x' }, ctx, orig)).length, 'unrelated edit allowed');
  assert(validateRecord('income', { ...orig, StartDate: '2026-02-02' }, ctx, orig).EndDate, 'date edit re-validated');
  const dq = dataQualityIssues({ ...b.ds, income: [orig] });
  assert(dq.some((i) => i.store === 'income' && i.field === 'EndDate'), 'reported in data quality');
});

// ---------- CSV ----------
test('CSV escaping: delimiters, quotes, newlines, formula-like text; raw numbers', () => {
  eq(csvCell('a,b'), '"a,b"'); eq(csvCell('say "hi"'), '"say ""hi"""'); eq(csvCell('l1\nl2'), '"l1\nl2"');
  eq(csvCell('=HYPERLINK("x")'), '"\'=HYPERLINK(""x"")"'); eq(csvCell('+1'), "'+1"); eq(csvCell('@SUM'), "'@SUM");
  const csv = toCSV([{ key: 'n', label: 'Name', type: 'text' }, { key: 'a', label: 'Amount', type: 'money' }, { key: 'm', label: 'Margin', type: 'pct' }], [{ n: 'X', a: Dec.from('-5.5'), m: Dec.from('0.85') }]);
  assert(csv.includes('Amount ($)') && csv.includes('-5.5000') && csv.includes('85'), csv);
});

test('aggregation keyed by IDs does not multiply rows when a project has many child records', () => {
  const b = builder();
  const c = b.client('Alpha'), p = b.project(c, 'Web'), a = b.person('A', 320000, 160);
  for (let i = 0; i < 3; i++) { b.income(p, '2026-01-01', 1000); b.cost(p, '2026-01-01', 100); b.time(p, a, '2026-01-01', 1); }
  const bk = aggregate(idxOf(b)).find((x) => x.projectId === p);
  eq(bk.paid, '3000'); eq(bk.costs, '300'); eq(bk.timeValue, '6000');
});

// ---------- recurring transactions ----------
import { addMonthsClamped, occurrencesBetween, dueOccurrences, horizonFor, frequencyLabel, lastDueDate, planHorizonTrim } from '../js/calc/recurring.js';
test('recurring: two-week window (Google 5k on the 11th)', () => {
  const rule = { RecurringID: 1, Kind: 'Cost', StartDate: '2026-08-11', EndDate: null, IntervalCount: 1, IntervalUnit: 'month', GeneratedThrough: null, Archived: null };
  eq(dueOccurrences(rule, '2026-09-10').join(), '2026-08-11,2026-09-11', 'past + tomorrow created, next month not');
  eq(dueOccurrences({ ...rule, GeneratedThrough: '2026-09-11' }, '2026-09-10').join(), '', 'nothing new');
  eq(dueOccurrences({ ...rule, GeneratedThrough: '2026-09-11' }, '2026-09-26').join(), '', '15 days away: not yet');
  eq(dueOccurrences({ ...rule, GeneratedThrough: '2026-09-11' }, '2026-09-27').join(), '2026-10-11', 'exactly 14 days away: created');
  eq(horizonFor('2026-01-31'), '2026-02-15'); eq(lastDueDate('2026-12-25'), '2027-01-08');
});
test('recurring: entries beyond the two-week window are trimmed only if untouched', () => {
  const rule = { RecurringID: 1, Kind: 'Cost', ProjectID: 4, Name: 'ChatGPT', Notes: null, Amount: '5527.3200', StartDate: '2026-10-01', EndDate: null, IntervalCount: 1, IntervalUnit: 'month', GeneratedThrough: '2026-11-01' };
  const rec = (d, amt = '5527.3200') => ({ CostID: d === '2026-10-01' ? 1 : 2, _store: 'costs', ProjectID: 4, StartDate: d, CostItem: 'ChatGPT', CostAmount: amt, CostNotes: null, RecurringID: 1 });
  let p = planHorizonTrim(rule, [rec('2026-10-01'), rec('2026-11-01')], '2026-10-03');
  eq(p.deletes.map((x) => x.StartDate).join(), '2026-11-01'); eq(p.generatedThrough, '2026-10-01');
  p = planHorizonTrim(rule, [rec('2026-10-01'), rec('2026-11-01', '6000.0000')], '2026-10-03');
  eq(p.deletes.length, 0, 'hand-edited future entry kept'); eq(p.generatedThrough, '2026-11-01');
  p = planHorizonTrim(rule, [rec('2026-10-01'), rec('2026-11-01')], '2026-10-20');
  eq(p.deletes.length, 0, 'within the window: kept');
});
test('recurring: month-end clamping, weeks, years, end date inclusive, frequency labels', () => {
  eq(addMonthsClamped('2026-01-31', 1), '2026-02-28'); eq(addMonthsClamped('2028-01-31', 1), '2028-02-29'); eq(addMonthsClamped('2026-11-15', 3), '2027-02-15');
  const m = { StartDate: '2026-01-31', EndDate: null, IntervalCount: 1, IntervalUnit: 'month' };
  eq(occurrencesBetween(m, null, '2026-05-01').join(), '2026-01-31,2026-02-28,2026-03-31,2026-04-30', 'no drift to the 28th');
  const w = { StartDate: '2026-03-02', EndDate: '2026-04-13', IntervalCount: 2, IntervalUnit: 'week' };
  eq(occurrencesBetween(w, null, '2027-01-01').join(), '2026-03-02,2026-03-16,2026-03-30', 'every 2 weeks; an end date on an occurrence closes the term (no 1-day period)');
  eq(occurrencesBetween({ ...w, EndDate: '2026-04-14' }, null, '2027-01-01').join(), '2026-03-02,2026-03-16,2026-03-30,2026-04-13', 'end date inside a period: that period is still due');
  eq(occurrencesBetween({ StartDate: '2026-03-02', EndDate: '2026-03-04', IntervalCount: 1, IntervalUnit: 'day' }, null, '2027-01-01').join(), '2026-03-02,2026-03-03,2026-03-04', 'daily: end date inclusive');
  eq(occurrencesBetween({ StartDate: '2026-02-28', EndDate: null, IntervalCount: 1, IntervalUnit: 'year' }, null, '2029-01-01').join(), '2026-02-28,2027-02-28,2028-02-28');
  eq(frequencyLabel({ IntervalCount: 1, IntervalUnit: 'month' }), 'Every month'); eq(frequencyLabel({ IntervalCount: 2, IntervalUnit: 'week' }), 'Every 2 weeks');
  assert(dueOccurrences({ ...m, Archived: true, GeneratedThrough: null }, '2026-06-01').length === 0, 'archived rule paused');
});

// ---------- whole periods only (no partial periods) ----------
import { occurrenceAmount, planRuleAdjustments, recordsForOccurrence, missingOccurrences } from '../js/calc/recurring.js';
test('recurring: every occurrence is the full amount, even when the end date falls mid-period', () => {
  const base = { RecurringID: 9, Kind: 'Cost', ProjectID: 5, Name: 'Ayesha Salary', Notes: null, Amount: '30000.0000', IntervalCount: 1, IntervalUnit: 'month' };
  const jan = { ...base, StartDate: '2026-01-01', EndDate: '2026-02-14' };
  eq(occurrencesBetween(jan, null, '2027-01-01').join(), '2026-01-01,2026-02-01', 'occurrences up to the end date');
  eq(occurrenceAmount(jan, '2026-02-01').amount, '30000.0000', 'last occurrence in full');
  eq(occurrenceAmount({ ...jan, Proration: 'days30' }, '2026-02-01').amount, '30000.0000', 'old Proration values are ignored');
  const wk = { ...base, Amount: '7000.0000', IntervalUnit: 'week', StartDate: '2026-03-02', EndDate: '2026-03-11' };
  eq(occurrenceAmount(wk, '2026-03-09').amount, '7000.0000', 'weekly: full week');
  eq(recordsForOccurrence(jan, '2026-02-01')[0].record.CostNotes, null, 'no partial note');
});
test('recurring: ending early removes untouched entries after the end date, keeps hand-edited ones', () => {
  const old = { RecurringID: 9, Kind: 'Cost', ProjectID: 5, Name: 'Salary', Notes: null, Amount: '30000.0000', IntervalCount: 1, IntervalUnit: 'month', StartDate: '2026-09-01', EndDate: null };
  const gen = (d, id) => ({ CostID: id, ...recordsForOccurrence(old, d)[0].record, revision: 1 });
  const recs = [gen('2026-09-01', 1), gen('2026-10-01', 2), { ...gen('2026-11-01', 3), CostAmount: '31000.0000' }];
  const plan = planRuleAdjustments(old, { ...old, EndDate: '2026-10-15' }, recs);
  eq(plan.updates.length, 0, 'October stays in full'); eq(plan.deletes.length, 0); eq(plan.skipped.length, 1, 'hand-edited Nov entry is left alone');
  const plan2 = planRuleAdjustments(old, { ...old, EndDate: '2026-10-15' }, recs.slice(0, 2).concat(gen('2026-11-01', 3)));
  eq(plan2.deletes.length, 1, 'untouched entry after the end date is removed');
});

test('recurring cost split: one share per project, per-share bookkeeping', () => {
  const rule = { RecurringID: 7, Kind: 'Cost', ProjectID: 5, SplitProjects: '8,9', Name: 'Tool', Notes: null, Amount: '10000.0000', IntervalCount: 1, IntervalUnit: 'month', StartDate: '2026-09-01', EndDate: null };
  const recs = recordsForOccurrence(rule, '2026-09-01').map((x) => x.record);
  eq(recs.map((r) => `${r.ProjectID}:${r.CostAmount}`).join(), '5:3333.3400,8:3333.3300,9:3333.3300');
  assert(recs.every((r) => r.RecurringID === 7 && r.CostNotes.includes('Split equally across 3 projects')), 'shares linked and noted');
  eq(recordsForOccurrence({ ...rule, Kind: 'Income' }, '2026-09-01').length, 1, 'income is never split');
  eq(recordsForOccurrence({ ...rule, SplitProjects: '5,5' }, '2026-09-01').length, 1, 'main project listed again is ignored');
  // ending before November: untouched November shares are removed, a hand-edited one is kept
  const gen = (d, k, id) => ({ CostID: id, ...recordsForOccurrence(rule, d)[k].record, revision: 1 });
  const nov = [gen('2026-11-01', 0, 1), { ...gen('2026-11-01', 1, 2), CostAmount: '9.0000' }, gen('2026-11-01', 2, 3)];
  const plan = planRuleAdjustments(rule, { ...rule, EndDate: '2026-10-15' }, nov);
  eq(plan.deletes.length, 2); eq(plan.skipped.length, 1, 'hand-edited share kept'); eq(plan.updates.length, 0);
  // missing: a period only counts as missing once all its shares are gone
  const done = { ...rule, GeneratedThrough: '2026-10-01' };
  const ds = (n) => ({ income: [], costs: [...Array(n)].map((_, i) => ({ CostID: i + 1, StartDate: i < 3 ? '2026-09-01' : '2026-10-01', RecurringID: 7 })) });
  eq(missingOccurrences(done, ds(6)).length, 0); eq(missingOccurrences(done, ds(4)).length, 0, 'one share left still covers October');
  eq(missingOccurrences(done, ds(3)).join(), '2026-10-01', 'all October shares deleted');
});

test('recurring: "missing" matches entries by period, not exact date (Aishas Salary case)', () => {
  const rule = { RecurringID: 3, Kind: 'Cost', StartDate: '2026-05-31', EndDate: '2026-11-22', IntervalCount: 1, IntervalUnit: 'month', GeneratedThrough: '2026-10-31' };
  const ds = (dates) => ({ income: [], costs: dates.map((d, i) => ({ CostID: i + 1, StartDate: d, RecurringID: 3 })) });
  // 6 entries created before the start date was changed from the 1st to the 31st
  eq(missingOccurrences(rule, ds(['2026-05-01', '2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01', '2026-10-01'])).length, 0, 'six entries = nothing missing');
  // entries on schedule, one moved by hand inside its month
  eq(missingOccurrences(rule, ds(['2026-05-31', '2026-06-30', '2026-07-25', '2026-08-31', '2026-09-30', '2026-10-31'])).length, 0, 'edited date still covers its period');
  // one really deleted
  eq(missingOccurrences(rule, ds(['2026-05-31', '2026-06-30', '2026-08-31', '2026-09-30', '2026-10-31'])).join(), '2026-07-31', 'only the deleted period');
  eq(missingOccurrences(rule, ds([])).length, 6, 'all deleted');
});

test('contracts: income, costs and margin come from the covered projects during the contract period', () => {
  const c = { ContractID: 1, ProjectIDs: '5,6' };
  const k = (o) => ({ ContractID: 1, StartDate: '2026-01-01', TermYears: null, TermMonths: 6, ...o });
  const ds = {
    clauses: [k({ ClauseID: 1 }), k({ ClauseID: 2, StartDate: '2026-03-01', TermMonths: 12 })],
    income: [{ ProjectID: 5, StartDate: '2025-12-31', AmountPaid: '100.0000' }, { ProjectID: 5, StartDate: '2026-01-01', AmountPaid: '1000.0000' }, { ProjectID: 6, StartDate: '2027-03-01', AmountPaid: '500.0000' }, { ProjectID: 7, StartDate: '2026-05-01', AmountPaid: '9.0000' }, { ProjectID: 6, StartDate: '2027-03-02', AmountPaid: '7.0000' }],
    costs: [{ ProjectID: 6, StartDate: '2026-06-15', CostAmount: '300.0000' }, { ProjectID: 8, StartDate: '2026-06-15', CostAmount: '50.0000' }],
  };
  eq(JSON.stringify(contractPeriod(c, ds.clauses)), JSON.stringify({ from: '2026-01-01', to: '2027-03-01' }), 'first start to last end');
  const a = contractActuals(c, ds);
  eq(a.income.toMoney(), '1500.0000', 'only covered projects, inside the period (both ends inclusive)');
  eq(a.cost.toMoney(), '300.0000'); eq(a.margin.toMoney(), '1200.0000');
  eq(contractActuals(c, { ...ds, clauses: [...ds.clauses, k({ ClauseID: 3, TermMonths: null })] }).income.toMoney(), '1507.0000', 'until-cancelled clause: no end');
  eq(contractActuals(c, { ...ds, clauses: [] }).income.toMoney(), '1607.0000', 'no clauses yet: all dates');
});
