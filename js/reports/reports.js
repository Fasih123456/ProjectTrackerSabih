// Report/query-view definitions. Each build() returns tables of raw values (Dec, strings, numbers);
// the UI formats them for screen/print and csv.js exports the raw values.
import { Dec } from '../lib/decimal.js';
import { inRange, monthLabel } from '../lib/dates.js';
import { COST_CATEGORIES, STORES } from '../model/schema.js';
import {
  projectRows, totalRow, companyTotals, salesSummary, acquisitionLines, activityEarning, timeEntryValue,
  projectLabel, personName, salespersonName, clientLabel, clientNameById,
} from '../calc/calc.js';
import { dataQualityIssues, invoiceCoverage } from '../calc/quality.js';

const Z = () => Dec.zero();
const sum = (rows, k) => Dec.sum(rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined));

// Shared project filter test (client/project filters apply through the record's project).
function projectMatch(idx, projectId, f) {
  if (f.projectId && projectId !== f.projectId) return false;
  if (f.clientId && idx.projects.get(projectId)?.ClientID !== f.clientId) return false;
  return true;
}
const clientName = (idx, pid) => clientLabel(idx.clients.get(idx.projects.get(pid)?.ClientID));
const projName = (idx, pid) => idx.projects.get(pid)?.ProjectName ?? `Missing project #${pid}`;

// Ledger estimated tax: 0.25% of total income (revenue, not profit).
export const LEDGER_TAX_RATE = Dec.from('0.0025');

const PERF_COLS = [
  { key: 'paid', label: 'Paid', type: 'money' },
  { key: 'actualCosts', label: 'Actual Costs', type: 'money', title: 'Project costs + earned sales fees' },
  { key: 'actualResult', label: 'Actual Result', type: 'money', signed: true },
  { key: 'timeValue', label: 'Time Value', type: 'money', title: 'Analytical only — not a salary payment' },
  { key: 'afterTime', label: 'After Time', type: 'money', signed: true },
  { key: 'margin', label: 'Margin', type: 'pct', signed: true },
];
const HOURS_DETAIL = [
  { key: 'hoursWorked', label: 'Hours', type: 'hours', detail: true },
];

export const REPORTS = [
  {
    id: 'project-lifetime', primary: true, title: 'Project Performance — All Months', orientation: 'landscape',
    subtitle: 'Client projects only. Actual result = paid income − project costs − earned sales fees. Time value is analytical and does not reduce the actual result or margin.',
    filters: ['dateRange', 'client', 'project'], dateNote: 'Income/costs by StartDate, time by WorkDate, sales fees by ActivityDate / income StartDate',
    build(idx, f) {
      const rows = projectRows(idx, { from: f.from, to: f.to, clientOnly: true, clientId: f.clientId, projectId: f.projectId });
      const t = { ...totalRow(rows, true), clientName: 'Overall total', projectName: '' };
      return { tables: [{ columns: [{ key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, ...PERF_COLS, ...HOURS_DETAIL], rows, totals: t, link: (r) => ({ store: 'projects', id: r.projectId }) }] };
    },
  },
  {
    id: 'monthly-client', title: 'Monthly Client Performance', orientation: 'landscape',
    subtitle: 'Client projects by month. Months come from income start dates, work dates, cost start dates and sales activity dates, so cost-only and time-only months are kept.',
    filters: ['dateRange', 'client', 'project'],
    build(idx, f) {
      const rows = projectRows(idx, { from: f.from, to: f.to, byMonth: true, clientOnly: true, clientId: f.clientId, projectId: f.projectId }).map((r) => ({ ...r, monthLabel: monthLabel(r.month) }));
      const t = { ...totalRow(rows, true), monthLabel: 'Total' };
      return { tables: [{ columns: [{ key: 'monthLabel', label: 'Month', type: 'text', sortKey: 'month' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, ...PERF_COLS, ...HOURS_DETAIL], rows, totals: t }] };
    },
  },
  {
    id: 'company-totals', primary: true, title: 'Company Totals — Cost Breakdown', orientation: 'portrait',
    subtitle: 'All recorded income minus every recorded cost and every earned sales fee, each counted once. Analytical time value is excluded. Owner salary is shown separately.',
    filters: ['dateRange'],
    build(idx, f) {
      const c = companyTotals(idx, f);
      const rows = [
        { label: 'Total Income', amount: c.income, kind: 'strong' },
        { label: 'Client Project Costs', amount: c.clientCosts },
        ...COST_CATEGORIES.filter((k) => k.code !== 'OWNERS_SALARY').map((k) => ({ label: k.name, amount: c.categories[k.code] })),
        ...c.otherInternal.map((o) => ({ label: `Other Internal Costs — ${o.label}`, amount: o.amount })),
        { label: 'Earned Sales Fees', amount: c.salesFees },
        { label: 'Total Before Owner Salary', amount: c.beforeOwner, kind: 'subtotal', signed: true },
        { label: 'Owners Salary', amount: c.ownerSalary },
        { label: 'Net After Owner Salary', amount: c.netAfterOwner, kind: 'total', signed: true },
        { label: 'Hours Worked', amount: c.hoursWorked, type: 'hours', kind: 'note' },
      ];
      return { tables: [{ columns: [{ key: 'label', label: 'Item', type: 'text' }, { key: 'amount', label: 'Amount', type: 'auto' }], rows, noSort: true }], company: c };
    },
  },
  {
    id: 'ledger', primary: true, title: 'Ledger', orientation: 'portrait',
    subtitle: `Recorded income and project costs, one line per project with income and expenses side by side (not netted): client projects as “Client - Project”, internal projects by name. Estimated tax (July 2027) = ${LEDGER_TAX_RATE.mul(100).toString()}% of total income (revenue, not profit).`,
    filters: ['dateRange'], dateNote: 'Income and costs by StartDate',
    build(idx, f) {
      const byProject = new Map(); // ProjectID -> { income, expense } (null = no records of that kind)
      const add = (pid, kind, amount) => {
        if (!byProject.has(pid)) byProject.set(pid, { income: null, expense: null });
        const t = byProject.get(pid);
        t[kind] = (t[kind] || Z()).add(amount);
      };
      for (const i of idx.ds.income) if (inRange(i.StartDate, f.from, f.to)) add(i.ProjectID, 'income', i.AmountPaid);
      for (const c of idx.ds.costs) if (inRange(c.StartDate, f.from, f.to)) add(c.ProjectID, 'expense', c.CostAmount);
      const projects = [...byProject.keys()].map((pid) => {
        const p = idx.projects.get(pid);
        const internal = !p || p.ProjectType === 'Internal' || !!idx.clients.get(p.ClientID)?.IsInternal;
        return { pid, internal, label: internal ? projName(idx, pid) : `${clientName(idx, pid)} - ${projName(idx, pid)}` };
      }).sort((a, b) => (a.internal - b.internal) || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }));
      const rows = [];
      for (const { pid, label } of projects) {
        const t = byProject.get(pid);
        rows.push({ projectId: pid, item: label, income: t.income, expense: t.expense });
      }
      const income = sum(rows, 'income'), expense = sum(rows, 'expense');
      const tax = income.mul(LEDGER_TAX_RATE).round(4);
      const summary = [
        { label: 'Total Income', amount: income },
        { label: 'Total Expenses', amount: expense },
        { label: 'Net (Income − Expenses)', amount: income.sub(expense), signed: true },
        { label: `Estimated Tax — July 2027 (${LEDGER_TAX_RATE.mul(100).toString()}% of income)`, amount: tax, kind: 'total' },
      ];
      return {
        tables: [
          { columns: [{ key: 'item', label: 'Item', type: 'text' }, { key: 'income', label: 'Income', type: 'money' }, { key: 'expense', label: 'Expense', type: 'money' }],
            rows, totals: { item: 'Total', income, expense }, noSort: true, link: (r) => ({ store: 'projects', id: r.projectId }) },
          { title: 'Summary', columns: [{ key: 'label', label: 'Item', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }], rows: summary, noSort: true },
        ],
      };
    },
  },
  {
    id: 'sales-team', primary: true, title: 'Sales Team — Commissions', orientation: 'landscape',
    subtitle: 'Earned = ordinary activity earnings + 180-day acquisition commission. Paid out = legacy activity CommissionPaid + sales payouts. Owed = earned − paid out (negative = advance/overpayment).',
    filters: ['dateRange', 'salesperson'],
    build(idx, f) {
      const rows = salesSummary(idx, { from: f.from, to: f.to, salespersonId: f.salespersonId });
      const period = !!(f.from || f.to);
      const base = [{ key: 'name', label: 'Salesperson', type: 'text' }, { key: 'meetings', label: 'Meetings Attended', type: 'int' }, { key: 'defaultFee', label: 'Default Fee per Meeting', type: 'money' }, { key: 'credited', label: 'Paid Revenue Credited', type: 'money' }];
      const cols = period
        ? [...base, { key: 'opening', label: 'Opening Balance', type: 'money', signed: true }, { key: 'earned', label: 'Period Earned', type: 'money' }, { key: 'paidOut', label: 'Period Paid Out', type: 'money' }, { key: 'closing', label: 'Closing Balance Owed', type: 'money', signed: true }]
        : [...base, { key: 'earned', label: 'Earned', type: 'money' }, { key: 'paidOut', label: 'Paid Out', type: 'money' }, { key: 'owed', label: 'Owed', type: 'money', signed: true }];
      const t = { name: 'Total', meetings: rows.reduce((n, r) => n + r.meetings, 0), defaultFee: null };
      for (const k of ['credited', 'earned', 'paidOut', 'owed', 'opening', 'closing']) t[k] = sum(rows, k);
      const notes = period ? ['Period view: opening balance = everything earned minus paid before the start date; closing balance = opening + period earned − period paid out.'] : [];
      return { tables: [{ columns: cols, rows, totals: t, link: (r) => ({ store: 'salespeople', id: r.spId }) }], notes };
    },
  },
  {
    id: 'acquisition-commissions', primary: true, title: 'Client Acquisition — Commission Detail', orientation: 'landscape',
    subtitle: 'One line per eligible income record: client projects, income StartDate on or after the acquisition date and before the exclusive stop date (acquisition date + 180 days). Commission rounded to 4 decimals per line.',
    filters: ['dateRange', 'client', 'salesperson'],
    build(idx, f) {
      const rows = acquisitionLines(idx)
        .filter((l) => inRange(l.income.StartDate, f.from, f.to) && (!f.clientId || l.acquisition.ClientID === f.clientId) && (!f.salespersonId || l.acquisition.SalespersonID === f.salespersonId))
        .map((l) => ({ incomeId: l.income.IncomeID, incomeDate: l.income.StartDate, clientName: clientNameById(idx, l.acquisition.ClientID), projectName: l.project.ProjectName, spName: salespersonName(idx, l.acquisition.SalespersonID), acqDate: l.acquisition.AcquisitionDate, stopDate: l.windowEnd, revenue: l.revenue, rate: l.acquisition.AcquisitionRate, commission: l.commission }))
        .sort((a, b) => a.incomeDate.localeCompare(b.incomeDate) || a.incomeId - b.incomeId);
      const t = { incomeDate: 'Total', revenue: sum(rows, 'revenue'), commission: sum(rows, 'commission'), rate: null };
      return { tables: [{ columns: [{ key: 'incomeDate', label: 'Income Date', type: 'date' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'spName', label: 'Salesperson', type: 'text' }, { key: 'acqDate', label: 'Acquisition Date', type: 'date' }, { key: 'stopDate', label: 'Exclusive Stop Date', type: 'date' }, { key: 'revenue', label: 'Paid Revenue', type: 'money' }, { key: 'rate', label: 'Earned Rate', type: 'rate' }, { key: 'commission', label: 'Earned Commission', type: 'money' }, { key: 'incomeId', label: 'IncomeID', type: 'int', detail: true }], rows, totals: t, link: (r) => ({ store: 'income', id: r.incomeId }) }] };
    },
  },
  {
    id: 'bank-details', primary: true, confidential: true, title: 'Employee Bank Details', orientation: 'portrait',
    subtitle: 'CONFIDENTIAL — employee banking information. Keep this report private. Includes employees with missing details.',
    filters: [],
    build(idx) {
      const rows = [...idx.ds.people].sort((a, b) => a.PersonName.localeCompare(b.PersonName) || a.PersonID - b.PersonID).map((p) => ({ id: p.PersonID, name: p.PersonName, bank: p.BankName, account: p.AccountName, iban: p.IBAN }));
      return { tables: [{ columns: [{ key: 'name', label: 'Employee', type: 'text' }, { key: 'bank', label: 'Bank Name', type: 'text' }, { key: 'account', label: 'Account Name', type: 'text' }, { key: 'iban', label: 'IBAN', type: 'mono' }], rows, link: (r) => ({ store: 'bank', id: r.id }) }] };
    },
  },
  {
    id: 'income-by-date', title: 'Income by Date', orientation: 'landscape',
    subtitle: 'Paid income, recognised in full on its StartDate. EndDate is descriptive only (no proration).',
    filters: ['dateRange', 'client', 'project'], dateNote: 'Filtered by StartDate',
    build(idx, f) {
      const rows = idx.ds.income.filter((i) => inRange(i.StartDate, f.from, f.to) && projectMatch(idx, i.ProjectID, f))
        .map((i) => ({ id: i.IncomeID, start: i.StartDate, end: i.EndDate, clientName: clientName(idx, i.ProjectID), projectName: projName(idx, i.ProjectID), amount: Dec.from(i.AmountPaid), notes: i.IncomeNotes }))
        .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);
      return { tables: [{ columns: [{ key: 'start', label: 'Start Date', type: 'date' }, { key: 'end', label: 'End Date', type: 'date' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'amount', label: 'Amount Paid', type: 'money' }, { key: 'notes', label: 'Notes', type: 'longtext' }], rows, totals: { start: 'Total', amount: sum(rows, 'amount') }, link: (r) => ({ store: 'income', id: r.id }) }] };
    },
  },
  {
    id: 'hours-by-date', title: 'Hours by Date', orientation: 'landscape',
    subtitle: 'Time entries by WorkDate. Effective hourly value = rate override if set, else monthly salary ÷ reference hours. Time value is analytical; salaries are recorded as costs.',
    filters: ['dateRange', 'client', 'project', 'person'], dateNote: 'Filtered by WorkDate',
    build(idx, f) {
      const rows = idx.ds.timeEntries.filter((t) => inRange(t.WorkDate, f.from, f.to) && projectMatch(idx, t.ProjectID, f) && (!f.personId || t.PersonID === f.personId))
        .map((t) => { const v = timeEntryValue(t, idx.people.get(t.PersonID)); return { id: t.TimeEntryID, date: t.WorkDate, clientName: clientName(idx, t.ProjectID), projectName: projName(idx, t.ProjectID), projectId: t.ProjectID, personId: t.PersonID, employee: personName(idx, t.PersonID), task: t.WorkTask, worked: t.HoursWorked === null ? null : Dec.from(t.HoursWorked), billed: t.HoursBilled === null ? null : Dec.from(t.HoursBilled), hourly: v.hourly, value: v.value }; })
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      const agg = (keyFn, labelFn) => {
        const m = new Map();
        for (const r of rows) { const k = keyFn(r); if (!m.has(k)) m.set(k, { label: labelFn(r), worked: Z(), billed: Z(), value: Z(), entries: 0 }); const a = m.get(k); a.worked = a.worked.add(r.worked ?? 0); a.billed = a.billed.add(r.billed ?? 0); if (r.value) a.value = a.value.add(r.value); a.entries++; }
        return [...m.values()].sort((a, b) => a.label.localeCompare(b.label));
      };
      const tot = { date: 'Total', worked: sum(rows, 'worked'), billed: sum(rows, 'billed'), value: sum(rows, 'value') };
      const aggCols = (first) => [{ key: 'label', label: first, type: 'text' }, { key: 'entries', label: 'Entries', type: 'int' }, { key: 'worked', label: 'Hours', type: 'hours' }, { key: 'value', label: 'Time Value', type: 'money' }];
      const byEmp = agg((r) => r.personId, (r) => r.employee), byProj = agg((r) => r.projectId, (r) => `${r.clientName} / ${r.projectName}`);
      return {
        tables: [
          { columns: [{ key: 'date', label: 'Work Date', type: 'date' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'employee', label: 'Employee', type: 'text' }, { key: 'task', label: 'Task', type: 'longtext' }, { key: 'worked', label: 'Hours', type: 'hours' }, { key: 'hourly', label: 'Effective Hourly Value', type: 'money' }, { key: 'value', label: 'Time Value', type: 'money' }], rows, totals: tot, link: (r) => ({ store: 'timeEntries', id: r.id }) },
          { title: 'By employee', columns: aggCols('Employee'), rows: byEmp, totals: { label: 'Total', entries: rows.length, worked: tot.worked, billed: tot.billed, value: tot.value } },
          { title: 'By project', columns: aggCols('Client / Project'), rows: byProj, totals: { label: 'Total', entries: rows.length, worked: tot.worked, billed: tot.billed, value: tot.value } },
        ],
      };
    },
  },
  {
    id: 'costs-by-date', title: 'Costs by Start Date', orientation: 'landscape',
    subtitle: 'Recorded costs, counted in full on their StartDate. EndDate does not spread the cost or create future bills.',
    filters: ['dateRange', 'client', 'project'], dateNote: 'Filtered by StartDate',
    build(idx, f) {
      const rows = idx.ds.costs.filter((c) => inRange(c.StartDate, f.from, f.to) && projectMatch(idx, c.ProjectID, f))
        .map((c) => ({ id: c.CostID, start: c.StartDate, end: c.EndDate, clientName: clientName(idx, c.ProjectID), projectName: projName(idx, c.ProjectID), item: c.CostItem, amount: Dec.from(c.CostAmount), notes: c.CostNotes }))
        .sort((a, b) => a.start.localeCompare(b.start) || a.id - b.id);
      return { tables: [{ columns: [{ key: 'start', label: 'Start Date', type: 'date' }, { key: 'end', label: 'End Date', type: 'date' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'item', label: 'Item', type: 'longtext' }, { key: 'amount', label: 'Cost Amount', type: 'money' }, { key: 'notes', label: 'Notes', type: 'longtext' }], rows, totals: { start: 'Total', amount: sum(rows, 'amount') }, link: (r) => ({ store: 'costs', id: r.id }) }] };
    },
  },
  {
    id: 'sales-by-date', title: 'Sales Activities by Date', orientation: 'landscape',
    subtitle: 'Earned per activity. "Legacy paid" is the old per-activity CommissionPaid field; the activity-level balance is not the salesperson\'s total outstanding (see Sales Team — Commissions).',
    filters: ['dateRange', 'client', 'project', 'salesperson'], dateNote: 'Filtered by ActivityDate',
    build(idx, f) {
      const rows = idx.ds.activities.filter((a) => inRange(a.ActivityDate, f.from, f.to) && projectMatch(idx, a.ProjectID, f) && (!f.salespersonId || a.SalespersonID === f.salespersonId))
        .map((a) => { const e = activityEarning(idx, a); return { id: a.ActivityID, date: a.ActivityDate, clientName: clientName(idx, a.ProjectID), projectName: projName(idx, a.ProjectID), sp: salespersonName(idx, a.SalespersonID), type: a.ActivityType + (e.suppressed ? ' (acquired client — see acquisition commission)' : ''), notes: a.LeadNotes, credited: e.credited, earned: e.earned, legacy: a.CommissionPaid === null ? null : Dec.from(a.CommissionPaid), owed: e.owed }; })
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      return { tables: [{ columns: [{ key: 'date', label: 'Activity Date', type: 'date' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'sp', label: 'Salesperson', type: 'text' }, { key: 'type', label: 'Type', type: 'text' }, { key: 'notes', label: 'Notes', type: 'longtext' }, { key: 'credited', label: 'Credited Paid Revenue', type: 'money' }, { key: 'earned', label: 'Earned', type: 'money' }, { key: 'legacy', label: 'Legacy Paid', type: 'money' }, { key: 'owed', label: 'Activity-level Owed (legacy)', type: 'money', signed: true }], rows, totals: { date: 'Total', credited: sum(rows, 'credited'), earned: sum(rows, 'earned'), legacy: sum(rows, 'legacy'), owed: sum(rows, 'owed') }, link: (r) => ({ store: 'activities', id: r.id }) }] };
    },
  },
  {
    id: 'payouts-by-date', title: 'Sales Payouts by Date', orientation: 'portrait',
    subtitle: 'Commission payments to salespeople, by PayoutDate. Payouts settle commission owed; they are not deducted from profit a second time.',
    filters: ['dateRange', 'salesperson'], dateNote: 'Filtered by PayoutDate',
    build(idx, f) {
      const rows = idx.ds.payouts.filter((p) => inRange(p.PayoutDate, f.from, f.to) && (!f.salespersonId || p.SalespersonID === f.salespersonId))
        .map((p) => ({ id: p.PayoutID, date: p.PayoutDate, sp: salespersonName(idx, p.SalespersonID), amount: Dec.from(p.AmountPaid), notes: p.PayoutNotes }))
        .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
      return { tables: [{ columns: [{ key: 'date', label: 'Payout Date', type: 'date' }, { key: 'sp', label: 'Salesperson', type: 'text' }, { key: 'amount', label: 'Amount Paid', type: 'money' }, { key: 'notes', label: 'Notes', type: 'longtext' }], rows, totals: { date: 'Total', amount: sum(rows, 'amount') }, link: (r) => ({ store: 'payouts', id: r.id }) }] };
    },
  },
  {
    id: 'monthly-project-detailed', title: 'Monthly Project Summary — Detailed', orientation: 'landscape',
    subtitle: 'Every project, including internal cost centres, by month. After-time and margin are unavailable (—) where they do not apply.',
    filters: ['dateRange', 'client', 'project'],
    build(idx, f) {
      const rows = projectRows(idx, { from: f.from, to: f.to, byMonth: true, clientId: f.clientId, projectId: f.projectId }).map((r) => ({ ...r, monthLabel: monthLabel(r.month) }));
      const t = { ...totalRow(rows, false), monthLabel: 'Total' };
      return { tables: [{ columns: [{ key: 'monthLabel', label: 'Month', type: 'text', sortKey: 'month' }, { key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'projectType', label: 'Type', type: 'text' }, { key: 'hoursWorked', label: 'Hours', type: 'hours' }, { key: 'paid', label: 'Paid', type: 'money' }, { key: 'costs', label: 'Project Costs', type: 'money' }, { key: 'salesFees', label: 'Earned Sales Fees', type: 'money' }, { key: 'timeValue', label: 'Time Value', type: 'money' }, { key: 'afterTime', label: 'After Time', type: 'money', signed: true }, { key: 'actualResult', label: 'Actual Result', type: 'money', signed: true }, { key: 'margin', label: 'Margin', type: 'pct', signed: true }], rows, totals: t }] };
    },
  },
  {
    id: 'data-quality', title: 'Data Quality', orientation: 'landscape',
    subtitle: 'Problems found in stored records (usually imported data). Nothing is rewritten automatically — open the record to review and fix it.',
    filters: [],
    build(idx) {
      const rows = dataQualityIssues(idx.ds).map((i) => ({ ...i, table: STORES[i.store].table }));
      const inv = invoiceCoverage(idx.ds);
      const coverage = { title: 'Invoices on income', noSort: true, columns: [{ key: 'label', label: 'Measure', type: 'text' }, { key: 'value', label: 'Value', type: 'text', align: 'right' }], rows: [
        { label: 'Income records without an invoice', value: inv.pct === null ? '—' : `${inv.pct.toFixed(1)}%` },
        { label: 'Without an invoice', value: `${inv.without} of ${inv.total}` },
        { label: 'With an invoice', value: String(inv.withInvoice) },
        ...(inv.future ? [{ label: 'Not counted: dated in the future', value: String(inv.future) }] : []),
      ] };
      return { tables: [coverage, { title: 'Problems found', columns: [{ key: 'severity', label: 'Severity', type: 'text' }, { key: 'table', label: 'Table', type: 'text' }, { key: 'id', label: 'Record ID', type: 'int' }, { key: 'field', label: 'Field', type: 'text' }, { key: 'message', label: 'Problem', type: 'longtext' }, { key: 'label', label: 'Record', type: 'text' }], rows, link: (r) => ({ store: r.store, id: r.id }), empty: 'No data-quality problems found.' }] };
    },
  },
];

export const REPORT_BY_ID = Object.fromEntries(REPORTS.map((r) => [r.id, r]));
export { projectLabel };
