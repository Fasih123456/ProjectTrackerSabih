// Screen configurations for the ten record modules.
import { h, replace, confirmDialog, alertDialog, toast, icon } from '../dom.js';
import { app, clientOptions, projectOptions, personOptions, salespersonOptions, contractOptions, sourceOptions, projectHiddenReason } from '../state.js';
import { contractStatus, renewalDecisionDate, noticeLabel, contractTotals, contractActuals, contractProjects, clauseStatus, clauseEndDate, termLabel, nextContractDates, renewalUrgency, contractUrgency, urgencyNote } from '../../calc/contracts.js';
import { Dec } from '../../lib/decimal.js';
import { todayISO, addDays, inRange } from '../../lib/dates.js';
import { fmtMoney, fmtRate, fmtHours, fmtMargin } from '../../lib/format.js';
import { weekChart } from '../weekChart.js';
import { BASE, BASE_NAME, BASE_SYMBOL, BASE_LABEL, isForeign, applyRate, clearFx, baseAmount, latestRate, fmtForeign, fmtRateValue, AMOUNT_FIELD } from '../../calc/fx.js';
import { enabledCurrencies, rateFor } from '../../io/fxRates.js';
import { attachmentsEditor, attachmentCounts, attachmentsOf, ATTACH_KIND } from '../attachments.js';
import { timeList } from '../timeList.js';
import { timeTracker } from '../timeTracker.js';
import { glyph } from '../table.js';
import { COST_CATEGORIES, CATEGORY_BY_CODE, ACTIVITY_TYPES, RECURRING_UNITS, NOTICE_UNITS, blankRecord, STORES } from '../../model/schema.js';
import { addMonthsClamped, parseIdList, frequencyLabel, nextOccurrence, dueOccurrences, horizonFor, occurrencesBetween, occurrenceAmount, monthlyEquivalent, missingOccurrences, lastDueDate, ruleProjects, isSalary, paysSalary, salaryRuleOf, salaryRuleFor, nthOccurrence, endBound } from '../../calc/recurring.js';
import {
  defaultHourly, timeEntryValue, activityEarning, acquisitionSummaries, salesSummary, salespersonBalance, acquisitionWindowEnd,
  projectLabel, personName, salespersonName, buildIndex, acquisitionLines, splitEqually, clientLabel, clientNameById,
} from '../../calc/calc.js';

const Z = () => Dec.zero();
const sum = (rows, k) => Dec.sum(rows.map((r) => r[k]).filter((v) => v !== null && v !== undefined));
const pv = (label, value, cls = '') => h('div', { class: `pv-row ${cls}` }, h('span', { class: 'pv-label' }, label), h('span', { class: 'pv-value' }, value));
const preview = (title, ...rows) => h('div', { class: 'preview-card' }, h('div', { class: 'preview-title' }, title), rows);
const clientIdOf = (pid) => app.idx.projects.get(pid)?.ClientID ?? null;
const cname = (pid) => clientNameById(app.idx, clientIdOf(pid));
const pname = (pid) => app.idx.projects.get(pid)?.ProjectName ?? `#${pid}`;

// Evaluate a draft record against the current snapshot (preview only — nothing is saved).
function withDraft(store, draft, key) {
  const ds = { ...app.ds, [store]: [...app.ds[store].filter((r) => r[key] !== draft[key] || draft[key] === null), { ...draft, [key]: draft[key] ?? -1 }] };
  return buildIndex(ds);
}

// "Every month · upcoming" for records created by a recurring rule; blank otherwise.
function repeatsLabel(r) {
  if (!r.RecurringID) return '';
  const rule = app.ds.recurring.find((x) => x.RecurringID === r.RecurringID);
  const freq = rule ? frequencyLabel(rule) : 'Rule deleted';
  return r.StartDate > todayISO() ? `${freq} · upcoming` : freq;
}
// Notes with the recurring label appended ("Hosting. Every month"), or the label alone when there is no note.
// Income and cost entries a recurring rule created (either store, in case its type was changed).
const ruleEntries = (rule) => [...app.ds.income, ...app.ds.costs].filter((x) => x.RecurringID === rule.RecurringID);

function withRepeats(notes, repeats) {
  const n = (notes || '').trim();
  if (!repeats) return notes;
  return n ? `${n.replace(/[.\s]+$/, '')}. ${repeats}` : repeats;
}
// ---------- splitting a cost across projects ----------
// Main project first, then the added "split with" projects (no duplicates).
const splitProjects = (d) => [...new Set([d.ProjectID, ...(d.SplitWith || [])].filter((x) => x !== null && x !== undefined))];
const SPLIT_NOTE_RE = /\n?Split equally across \d+ projects \(total [^)]*\)\.?/g; // replaced, not repeated, when re-splitting
const splitField = (name, help, extra = {}) => ({
  name, label: 'Split equally with other projects (optional)', type: 'tags', wide: true, help,
  options: () => projectOptions(), exclude: (v) => v.ProjectID ?? null, labelOf: (id) => projectLabel(app.idx, id), ...extra,
});
// Shares of an amount; in another currency they are shown in that currency with the base-currency value at the latest rate.
function splitRows(ids, amount, currency = null) {
  const parts = amount === null || amount === undefined ? null : splitEqually(amount, ids.length);
  const foreign = !!currency && currency !== BASE;
  const lr = foreign ? latestRate(currency) : null;
  const fmt = (a) => (!foreign ? fmtMoney(a) : `${fmtForeign(currency, a)}${lr ? ` (≈ ${fmtMoney(baseAmount(a, lr.rate))})` : ''}`);
  return [...ids.map((pid, k) => pv(projectLabel(app.idx, pid), parts ? fmt(parts[k]) : 'Enter the amount')), parts ? pv('Total', fmt(Dec.sum(parts)), 'pv-strong') : null,
    parts && lr ? h('p', { class: 'muted small' }, `${BASE_SYMBOL} amounts shown at the latest rate (${lr.date}); each entry uses the rate of its own date.`) : null];
}
const splitPreview = (ids, amount, currency = null) => (ids.length < 2 ? null : preview(`Split across ${ids.length} projects (preview — nothing is saved until you press Submit)`, splitRows(ids, amount, currency)));
// Small coloured labels used in list cells (type / status / contract chips).
const pill = (text, tone, dot = false) => h('span', { class: `pill pill-${tone}` }, dot ? h('span', { class: 'pill-dot', 'aria-hidden': 'true' }) : null, text);
const plural = (n, word, many = word + 's') => `${n} ${n === 1 ? word : many}`;
const hoursOf = (rows, k) => Dec.sum(rows.map((r) => (r[k] === null || r[k] === undefined ? Dec.zero() : Dec.from(r[k]))));
const UNIT_LABELS ={ day: 'day(s)', week: 'week(s)', month: 'month(s)', year: 'year(s)' };
// Two-letter avatar text: first letters of the first two words, or the first two letters of a single word.
// ---------- multi-currency (income and costs) ----------
// The form has Currency (blank = the base currency, CAD); for another currency the amount is entered in that currency and converted
// to the base currency on Submit at the mid-market rate of the record's date (or the actual rate received, when typed in).
const currencyOptions = (current) => {
  const codes = enabledCurrencies();
  if (current && current !== BASE && !codes.includes(current)) codes.push(current);
  return codes.map((c) => ({ value: c, label: c }));
};
function fxFields(ex, amountField) {
  return [
    { name: 'Currency', label: 'Currency', type: 'select', numeric: false, placeholder: `${BASE_LABEL} (${BASE_NAME})`, options: () => currencyOptions(ex?.Currency), help: `Totals and reports are always in ${BASE_LABEL}. Manage currencies under Admin → Currencies.` },
    { ...amountField, hidden: (v) => isForeign(v) },
    { name: 'OriginalAmount', label: `${amountField.label} (in that currency)`, type: 'money', required: true, unit: ' ', hidden: (v) => !isForeign(v), help: amountField.help },
    { name: 'ManualRate', label: 'Actual rate received (optional)', type: 'number', unit: BASE_SYMBOL, hidden: (v) => !isForeign(v), help: `${BASE_LABEL} per 1 unit your bank actually gave. Leave blank to use the mid-market rate of the start date (looked up automatically).` },
  ];
}
// Suffixes follow the chosen currency ("USD", "$ per USD").
function fxSuffixes(form) {
  const code = form.controls.Currency?.input.value || BASE;
  const set = (name, text) => { const sfx = form.controls[name]?.row.querySelector('.suffix'); if (sfx) sfx.textContent = text; };
  set('OriginalAmount', code); set('ManualRate', `${BASE_SYMBOL} per ${code}`);
}
const fxInitial = (base, ex) => { base.ManualRate = ex && isForeign(ex) && ex.FxStatus === 'manual' ? ex.FxRate : null; };
const fxValidate = (d) => (isForeign(d) && d.ManualRate !== null && d.ManualRate !== undefined && !(d.ManualRate > 0) ? { ManualRate: 'The rate must be greater than zero' } : {});
// Before validation: base currency -> clear the currency fields; typed-in rate -> apply it; unchanged automatic rate -> keep it;
// otherwise a stand-in rate is set and the real one is looked up on Submit (fxBeforeSubmit).
function fxPrepare(store, d, ex) {
  const field = AMOUNT_FIELD[store];
  d._fxLookup = false;
  if (!isForeign(d)) { clearFx(d); return; }
  if (d.OriginalAmount === null || d.OriginalAmount === undefined) { d[field] = null; return; }
  if (d.ManualRate > 0) { applyRate(store, d, d.ManualRate, d.StartDate, 'manual'); return; }
  if (ex && isForeign(ex) && ex.FxStatus !== 'manual' && ex.Currency === d.Currency && ex.StartDate === d.StartDate && ex.OriginalAmount === d.OriginalAmount) {
    Object.assign(d, { FxRate: ex.FxRate, FxDate: ex.FxDate, FxStatus: ex.FxStatus, [field]: ex[field] });
    return;
  }
  const lr = latestRate(d.Currency);
  applyRate(store, d, lr?.rate ?? 1, lr?.date ?? d.StartDate, 'provisional');
  d._fxLookup = true;
}
async function fxBeforeSubmit(store, d) {
  if (!d._fxLookup) return true;
  try {
    const r = await rateFor(d.Currency, d.StartDate);
    applyRate(store, d, r.rate, r.date, r.status);
    if (r.note) toast(r.note, 'info', 9000);
    return true;
  } catch (e) {
    await alertDialog(`${e.message} To save now, type the actual rate received; otherwise try again when you are online.`, { title: 'Exchange rate not available' });
    return false;
  }
}
// Live preview: the rate that will be used and the base-currency amount (looked up as you type; each day is downloaded once).
function fxPreview(store, d) {
  if (!isForeign(d)) return null;
  if (d.OriginalAmount === null || d.OriginalAmount === undefined || !d.StartDate) return preview('Exchange rate', pv('Rate', 'Enter the amount and the start date'));
  const show = (rate, label, note) => [
    pv('Rate', `1 ${d.Currency} = ${fmtRateValue(rate)} ${BASE_LABEL} (${label})`),
    pv(`Amount in ${BASE_LABEL}`, fmtMoney(baseAmount(d.OriginalAmount, rate)), 'pv-strong'),
    note ? h('p', { class: 'note note-info' }, note) : null];
  if (d.ManualRate > 0) return preview('Exchange rate (preview)', show(d.ManualRate, 'actual rate received'));
  const box = preview('Exchange rate (preview)', pv('Rate', 'Looking up…'));
  rateFor(d.Currency, d.StartDate)
    .then((r) => replace(box, h('div', { class: 'preview-title' }, 'Exchange rate (preview)'), show(r.rate, r.status === 'final' ? `mid-market, ${r.date}` : `provisional, ${r.date}`, r.note)))
    .catch((e) => replace(box, h('div', { class: 'preview-title' }, 'Exchange rate'), pv('Rate', e.message)));
  return box;
}
// List column: "USD 100.00 @ 277.0088" with a chip for provisional / typed-in rates.
const fxCell = (rec) => {
  if (!isForeign(rec)) return '';
  const tone = rec.FxStatus === 'provisional' ? 'warn' : 'neutral';
  const chip = rec.FxStatus === 'final' ? null : pill(rec.FxStatus === 'manual' ? 'actual rate' : 'provisional', tone);
  return h('span', { class: 'fx-cell', title: `Rate of ${rec.FxDate}${rec.FxStatus === 'provisional' ? ' — updated automatically once the rate of ' + rec.StartDate + ' is published' : ''}` },
    fmtForeign(rec.Currency, rec.OriginalAmount), h('span', { class: 'muted small' }, ` @ ${fmtRateValue(rec.FxRate)}`), chip ? ' ' : null, chip);
};
// Receipts / invoices: editor section, list column (paperclip + count) and the delete note.
const attachHooks = (store) => ({
  formExtra: (ex) => attachmentsEditor(store, ex),
  deleteNote: (rec) => { const n = attachmentsOf(store, rec[STORES[store].key]).length; return n ? ` Its ${n === 1 ? ATTACH_KIND[store].one : `${n} ${ATTACH_KIND[store].many}`} ${n === 1 ? 'is' : 'are'} deleted too.` : ''; },
});
const filesColumn = (store) => ({ key: 'files', label: ATTACH_KIND[store].title, type: 'int', align: 'center',
  render: (r) => (r._rec && r.files ? h('span', { class: 'att-count', title: `${r.files} ${r.files === 1 ? ATTACH_KIND[store].one : ATTACH_KIND[store].many} attached` }, icon.clip(), String(r.files)) : '') });
const fxText = (rec) => (isForeign(rec) ? `${fmtForeign(rec.Currency, rec.OriginalAmount)} @ ${fmtRateValue(rec.FxRate)} (${rec.FxStatus})` : '');

// A rule's monthly equivalent in the base currency (another currency at the latest rate; null when no rate is known yet).
function rulePerMonthBase(r) {
  const m = monthlyEquivalent(r);
  if (!isForeign(r) || m === null || m === undefined) return m;
  const lr = latestRate(r.Currency);
  return lr ? Dec.from(m).mul(String(lr.rate)).round(4) : null;
}

const initials = (name) => { const w = String(name || '?').trim().split(/\s+/); return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase(); };

export const CONFIGS = {
  recurring: {
    store: 'recurring', title: 'Recurring Transactions', addLabel: 'Add recurring', archivable: true, filters: ['client', 'project', 'type:Income|Cost'], wideForm: true,
    description: 'Repeating income or expenses (subscriptions, retainers, salaries). Each occurrence is added automatically as a normal income or cost record once it is 14 days away or less (two weeks ahead) — never further ahead. Generated records can be edited or deleted individually; a deleted occurrence is not recreated.',
    describe: (r) => `${r.Kind}: ${r.Name}`,
    columns: () => [
      { key: 'name', label: 'Task / Name', type: 'text', strong: true }, { key: 'project', label: 'Client / Project', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money', render: (r) => (r._rec && isForeign(r._rec) ? fmtForeign(r._rec.Currency, r._rec.Amount) : fmtMoney(r.amount)) }, { key: 'freq', label: 'Frequency', type: 'text' },
      { key: 'perMonth', label: 'Per Month', type: 'money', strong: true, title: 'Average per month (weekly × 52 ÷ 12, yearly ÷ 12…). Totals count active rules only.' },
      { key: 'date', label: 'Start Date', type: 'date' }, { key: 'end', label: 'End Date', type: 'date' }, { key: 'next', label: 'Next Not Yet Added', type: 'date' },
      { key: 'count', label: 'Entries Added', type: 'int' },
      { key: 'status', label: 'Status', type: 'text', align: 'center', render: (r) => (r._rec ? pill(r.status, r.missing.length ? 'neg' : r.status === 'Active' ? 'pos' : r.active ? 'warn' : 'neutral', r.status === 'Active') : r.status) },
    ],
    rows: () => app.ds.recurring.map((r) => {
      const store = r.Kind === 'Income' ? 'income' : 'costs';
      const next = nextOccurrence(r);
      // Active until the end date has passed (even when its last entry is already created); paused if archived.
      const status = r.Archived ? 'Paused (archived)' : r.EndDate && addDays(endBound(r), -1) < todayISO() ? 'Ended' : next ? 'Active' : 'Active · all entries added';
      const missing = missingOccurrences(r, app.ds); // scheduled dates whose entries were deleted
      return { _rec: r, type: r.Kind, kind: r.Kind, name: r.Name, projectId: r.ProjectID, clientId: clientIdOf(r.ProjectID), project: projectLabel(app.idx, r.ProjectID) + (ruleProjects(r).length > 1 ? ` (split equally with ${ruleProjects(r).slice(1).map((id) => projectLabel(app.idx, id)).join(', ')})` : ''), amount: Dec.from(r.Amount), freq: frequencyLabel(r), perMonth: rulePerMonthBase(r), active: status.startsWith('Active'), date: r.StartDate, end: r.EndDate, next, count: app.ds[store].filter((x) => x.RecurringID === r.RecurringID).length, missing, status: missing.length ? `${status} · ${missing.length} missing` : status };
    }),
    // Entries deleted on purpose are never recreated automatically; this button re-creates them with the rule's current values.
    rowActions: (row) => row.missing.length ? h('button', { type: 'button', class: 'btn btn-small btn-primary', 'aria-label': `Re-create ${row.missing.length} missing entries for ${row.name}`, onclick: async () => {
      const r = row._rec;
      const amounts = row.missing.map((d) => `${d}: ${fmtMoney(occurrenceAmount(r, d).amount)}`);
      if (!(await confirmDialog(`Re-create ${row.missing.length} missing ${r.Kind === 'Income' ? 'income' : 'cost'} entr${row.missing.length === 1 ? 'y' : 'ies'} for “${r.Name}” using the rule's current amount?`, { title: 'Re-create missing entries', ok: 'Re-create entries', details: h('ul', {}, amounts.map((a) => h('li', {}, a))) }))) return;
      try {
        const made = await app.db.recreateMissingRecurring(r.RecurringID);
        await app.reload(); app.render();
        toast(`Re-created ${made.length} entr${made.length === 1 ? 'y' : 'ies'} for ${r.Name}.`);
      } catch (e) { alertDialog(e.fields ? Object.values(e.fields).join(' ') : e.message, { title: 'Nothing was re-created' }); }
    } }, icon.plus(), ` Re-create ${row.missing.length} missing`) : null,
    csvColumns: () => [{ key: 'kind', label: 'Type', type: 'text' }, ...CONFIGS.recurring.columns()],
    // Separate Income and Costs tables, each totalled per month (active rules only), plus a net summary.
    sections: [
      { title: 'Recurring Income', filter: (r) => r.kind === 'Income', empty: 'No recurring income matches.' },
      { title: 'Recurring Costs', filter: (r) => r.kind === 'Cost', empty: 'No recurring costs match.' },
    ],
    totals: (rows) => {
      const act = rows.filter((r) => r.active);
      return { name: 'Total per month (active)', amount: null, perMonth: Dec.sum(act.map((r) => r.perMonth).filter(Boolean)), count: rows.reduce((n, r) => n + r.count, 0), status: `${act.length} active` };
    },
    // Monthly equivalents of the active rules matching the filters: income, costs and the net between them.
    kpis: (rows) => {
      const act = (kind) => rows.filter((r) => r.active && r.kind === kind);
      const pm = (kind) => Dec.sum(act(kind).map((r) => r.perMonth).filter(Boolean));
      const inc = pm('Income'), cost = pm('Cost'), net = inc.sub(cost);
      const sign = net.round(2).sign();
      const margin = inc.isZero() ? null : net.div(inc, 10);
      return [
        { label: 'Recurring income per month', value: fmtMoney(inc), sub: `${plural(act('Income').length, 'active income rule')}`, icon: 'arrowUp', tone: 'teal' },
        { label: 'Recurring costs per month', value: fmtMoney(cost), sub: `${plural(act('Cost').length, 'active cost rule')}`, icon: 'arrowDown', tone: 'rose' },
        { label: 'Net per month', value: fmtMoney(net), valueTone: sign < 0 ? 'neg' : sign > 0 ? 'pos' : '', sub: margin === null ? 'No recurring income' : `${fmtMargin(margin)} of recurring income`, subTone: sign < 0 ? 'neg' : sign > 0 ? 'pos' : '', icon: 'money', tone: sign < 0 ? 'rose' : 'green', highlight: sign < 0 ? 'neg' : sign > 0 ? 'pos' : null },
      ];
    },
    defaults: () => ({ Kind: 'Cost', StartDate: todayISO(), IntervalCount: 1, IntervalUnit: 'month' }),
    formIntro: (ex) => ex && isSalary(ex) ? h('p', { class: 'note note-warning' }, 'This is an employee’s salary. It is managed on ', h('a', { href: `#/people?edit=${ex.PersonID}` }, 'Employees & Rates'), ': change the salary, join date or leave date there.')
      : ex && ruleEntries(ex).length ? h('p', { class: 'note note-info' }, `This rule has already added ${plural(ruleEntries(ex).length, 'entry', 'entries')}. Choose how to save: “Save, keep old entries” changes only the occurrences not yet added and leaves every existing entry exactly as it is. “Save & update old entries” rebuilds the existing entries from the edited rule (amount, name, project, split, notes and dates), overwriting any hand edits and bringing back occurrences you deleted.`) : null,
    // Editing a rule that has created entries: keep them as they are, or rebuild them from the edited rule.
    saveModes: (ex) => (isSalary(ex) || !ruleEntries(ex).length ? null : [
      { label: 'Save, keep old entries', kind: 'secondary-solid', opts: { entries: 'keep' }, title: 'Only occurrences not yet added use the new values' },
      { label: 'Save & update old entries', opts: { entries: 'rebuild' }, title: 'Re-make every entry this rule added from the edited rule' },
    ]),
    // Deleting a rule that has created entries: delete them too, or keep them as ordinary records.
    deleteChoices: (rec) => {
      const n = ruleEntries(rec).length;
      if (!n) return null;
      const what = plural(n, rec.Kind === 'Income' ? 'income entry' : 'cost entry', rec.Kind === 'Income' ? 'income entries' : 'cost entries');
      return {
        message: `“${rec.Name}” has added ${what}. Delete them as well, or keep them as ordinary records (reports and totals then stay unchanged)? This cannot be undone.`,
        choices: [
          { label: 'Delete rule only, keep entries', kind: 'secondary-solid', value: { withEntries: false } },
          { label: `Delete rule and ${what}`, kind: 'danger', value: { withEntries: true } },
        ],
        done: (removed, o) => (o.withEntries ? `Deleted “${rec.Name}” and ${plural(removed, 'entry', 'entries')}.` : `Deleted “${rec.Name}”. Its ${what} were kept.`),
      };
    },
    formFields: (ex) => [
      { name: 'Kind', label: 'Type', type: 'select', required: true, numeric: false, options: () => [{ value: 'Cost', label: 'Cost (expense)' }, { value: 'Income', label: 'Income' }] },
      { name: 'Name', label: 'Task / name', type: 'text', required: true, help: 'e.g. Google Workspace subscription. Used as the cost item (or income note).' },
      { name: 'ProjectID', label: 'Project / internal cost centre', type: 'select', required: true, wide: true, options: () => projectOptions(ex?.ProjectID) },
      splitField('SplitProjects', 'Add projects to share this cost. Each occurrence then adds a cost record per project with an equal share of the amount.',
        { asText: true, hidden: (v) => v.Kind !== 'Cost', hiddenValue: null }),
      { name: 'Currency', label: 'Currency', type: 'select', numeric: false, placeholder: `${BASE_LABEL} (${BASE_NAME})`, options: () => currencyOptions(ex?.Currency), hidden: () => !!ex && isSalary(ex), help: `Each entry is converted to ${BASE_LABEL} at the mid-market rate of its own date.` },
      { name: 'Amount', label: 'Amount each time', type: 'money', required: true },
      { name: 'StartDate', label: 'Start date (first occurrence)', type: 'date', required: true },
      { name: 'IntervalCount', label: 'Repeat every', type: 'number', required: true, help: 'Whole number, e.g. 1, 2 or 3.' },
      { name: 'IntervalUnit', label: 'Unit', type: 'select', required: true, numeric: false, options: () => RECURRING_UNITS.map((u) => ({ value: u, label: UNIT_LABELS[u] })) },
      { name: 'EndDate', label: 'End date (optional, last day covered)', type: 'date', help: 'Leave blank to repeat until you end or archive it. Occurrences up to and including this date are added in full.' },
      { name: 'Notes', label: 'Notes', type: 'textarea' },
    ],
    onChange: (form, name) => { if (name === 'ProjectID') form.refreshOptions(); const sfx = form.controls.Amount.row.querySelector('.suffix'); if (sfx) sfx.textContent = form.controls.Currency.input.value || BASE_SYMBOL; },
    onInit: (form) => { const sfx = form.controls.Amount.row.querySelector('.suffix'); if (sfx) sfx.textContent = form.controls.Currency.input.value || BASE_SYMBOL; },
    preview: (d, ex) => {
      const ok = d.StartDate && Number.isInteger(d.IntervalCount) && d.IntervalCount >= 1 && d.IntervalUnit && (!d.EndDate || d.EndDate >= d.StartDate);
      if (!ok) return preview('Schedule', pv('Occurrences', 'Enter a start date and a frequency'));
      const today = todayISO(), horizon = horizonFor(today);
      const rule = { ...d, GeneratedThrough: ex?.GeneratedThrough ?? null, Archived: ex?.Archived ?? null };
      const hasAmt = d.Amount !== null && d.Amount !== undefined;
      const money = (date) => (!hasAmt ? '' : isForeign(d) ? fmtForeign(d.Currency, occurrenceAmount(rule, date).amount) : fmtMoney(occurrenceAmount(rule, date).amount));
      const list = (dates) => dates.map((x) => `${x}${hasAmt ? ` (${money(x)})` : ''}`).join(', ');
      const due = dueOccurrences(rule, today);
      const later = occurrencesBetween(rule, due.length ? due[due.length - 1] : rule.GeneratedThrough, '9999-12-31').filter((x) => x >= horizon).slice(0, 3);
      let last = null;
      if (d.EndDate) { const all = occurrencesBetween(rule, null, addDays(d.EndDate, 1)); last = all[all.length - 1] || null; }
      const lastAmt = last && hasAmt ? occurrenceAmount(rule, last) : null;
      const total = d.EndDate && hasAmt ? Dec.sum(occurrencesBetween(rule, null, addDays(d.EndDate, 1)).map((x) => occurrenceAmount(rule, x).amount)) : null;
      return preview('Schedule (preview — nothing is added until you press Submit)',
        pv('Frequency', frequencyLabel(rule)),
        pv('Added when you press Submit', due.length ? `${due.length} entr${due.length === 1 ? 'y' : 'ies'}: ${due.length > 6 ? `${list(due.slice(0, 3))} … ${list(due.slice(-2))}` : list(due)}` : 'None yet (next occurrence is more than 14 days away)'),
        pv('Added automatically later', later.length ? `${list(later)}${later.length === 3 ? ' …' : ''}` : '—'),
        lastAmt ? pv('Last instance', `${last}: ${money(last)}`) : null,
        total ? pv('Total over the whole schedule', fmtMoney(total)) : null,
        pv('Two-week window', `occurrences up to ${lastDueDate(today)} are added now`),
        ex && !ruleEntries(ex).length && ex.EndDate !== d.EndDate ? h('p', { class: 'note note-info' }, 'No entries have been added yet, so the new schedule applies from the start.') : null,
        d.Kind === 'Cost' && ruleProjects(d).length > 1 ? [h('div', { class: 'preview-title' }, `Each full occurrence, split across ${ruleProjects(d).length} projects`), splitRows(ruleProjects(d), d.Amount, d.Currency)] : null);
    },
    afterSave: async (saved) => {
      const a = saved?._adjusted;
      if (a?.rebuilt) toast(`Existing entries updated: ${plural(a.deleted, 'old entry', 'old entries')} replaced by ${plural(a.created, 'entry', 'entries')} from the edited rule.`, 'ok', 9000);
      else if (a && (a.updated || a.deleted || a.skipped)) toast(`Existing entries corrected for the new end date: ${a.updated} adjusted, ${a.deleted} removed${a.skipped ? `, ${a.skipped} edited by hand left unchanged` : ''}.`, a.skipped ? 'warn' : 'ok', 9000);
      return app.runRecurring?.();
    },
  },

  clients: {
    store: 'clients', title: 'Clients', addLabel: 'Add client', archivable: true,
    description: 'Clients and the internal client that holds company cost centres. A client can have several projects.',
    describe: (r) => clientLabel(r),
    columns: () => [
      { key: 'name', label: 'Client', type: 'text', strong: true }, { key: 'company', label: 'Company', type: 'text' },
      { key: 'website', label: 'Website', type: 'text', render: (r) => (r.website ? h('a', { class: 'link-ext', href: /^https?:\/\//i.test(r.website) ? r.website : `https://${r.website}`, target: '_blank', rel: 'noopener noreferrer' }, r.website, glyph.external()) : '') },
      { key: 'phone', label: 'Phone', type: 'text', render: (r) => (r.phone ? h('a', { class: 'link-plain cell-mono', href: `tel:${r.phone.replace(/[^\d+]/g, '')}` }, r.phone) : '') },
      { key: 'email', label: 'Email', type: 'text', render: (r) => (r.email ? h('a', { class: 'link-plain', href: `mailto:${r.email}` }, r.email) : '') },
      { key: 'kind', label: 'Type', type: 'text', align: 'center', render: (r) => pill(r.kind, r._rec.IsInternal ? 'warn' : 'brand') },
      { key: 'projects', label: 'Projects', type: 'int', render: (r) => h('span', { class: `num-badge${r.projects > 1 ? ' brand' : ''}` }, String(r.projects)) },
      { key: 'source', label: 'Source', type: 'text', render: (r) => (r.source ? pill(r.source, 'brand') : '') },
      { key: 'acq', label: 'Acquisition', type: 'text', render: (r) => (r.acq ? pill(r.acq, 'pos') : '') },
      { key: 'status', label: 'Status', type: 'text', align: 'center', render: (r) => pill(r.status, CLIENT_STATUS_TONE[r.status] || 'neutral', true) },
    ],
    // acq: the acquiring salesperson's name (searchable), shown as a chip.
    rows: () => app.ds.clients.map((c) => { const a = app.idx.acqByClient.get(c.ClientID); return { _rec: c, clientId: c.ClientID, name: c.ClientName, company: c.CompanyName, website: c.Website, phone: c.Phone, email: c.Email, kind: c.IsInternal ? 'Internal' : 'Client', source: app.ds.sources.find((s) => s.SourceID === c.SourceID)?.SourceName ?? '', projects: app.ds.projects.filter((p) => p.ClientID === c.ClientID).length, acq: a ? `Acquired · ${salespersonName(app.idx, a.SalespersonID)}` : '', status: clientStatus(c) }; }),
    // current = not archived and not the internal client; Active = has an active contract.
    kpis: (rows) => {
      const current = rows.filter((r) => !r._rec.Archived && !r._rec.IsInternal);
      const active = current.filter((r) => r.status === 'Active').length, inactive = current.filter((r) => r.status === 'Inactive').length;
      return [
        { label: 'Active clients', value: active, unit: `of ${current.length}`, sub: `With an active contract · ${plural(rows.filter((r) => r._rec.IsInternal).length, 'internal client')} not counted`, icon: 'users', tone: 'teal' },
        { label: 'Projects', value: current.reduce((n, r) => n + r.projects, 0), unit: 'client projects', sub: 'Across clients that are not archived', icon: 'folder', tone: 'blue' },
        { label: 'Inactive clients', value: inactive, unit: `of ${current.length}`, sub: 'No active or upcoming contract (not archived)', icon: 'contract', tone: inactive ? 'amber' : 'indigo' },
        { label: 'Acquired by sales', value: current.filter((r) => r.acq).length, unit: `of ${current.length}`, sub: 'Clients with an acquisition record', icon: 'trend', tone: 'green' },
      ];
    },
    formFields: (ex) => [
      { name: 'ClientName', label: 'Client name', type: 'text', required: true, help: 'The contact person, e.g. Jordan.' },
      { name: 'CompanyName', label: 'Company name', type: 'text', help: 'Shown as “Client name - Company name” everywhere.' },
      { name: 'Website', label: 'Website', type: 'text', placeholder: 'e.g. example.com' },
      { name: 'Phone', label: 'Phone number', type: 'text', placeholder: 'e.g. +1 416 555 0100' },
      { name: 'Email', label: 'Email', type: 'text', wide: true, placeholder: 'name@company.com' },
      { name: 'IsInternal', label: 'Internal client (company cost centres, not a customer)', type: 'checkbox', wide: true, help: 'Normally only one internal client is needed. Its projects must be type Internal.' },
      // Acquisition: where the client came from (SourceID) and, optionally, the salesperson acquisition record
      // (Acq* fields are form-only; afterSave creates, updates or removes the client's acquisitions record).
      { name: 'SourceID', label: 'Acquisition source', type: 'select', placeholder: '— Not recorded —', options: () => sourceOptions(ex?.SourceID), hidden: (v) => !!v.IsInternal, help: 'Where the client came from, e.g. Fiverr. Manage the list under Clients → Acquisition Sources.' },
      { name: 'AcqSalespersonID', label: 'Acquired by salesperson', type: 'select', placeholder: '— No salesperson —', options: () => salespersonOptions(app.idx.acqByClient.get(ex?.ClientID)?.SalespersonID ?? null), hidden: (v) => !!v.IsInternal, help: 'Optional. The salesperson earns the acquisition rate on this client’s income for 180 days.' },
      { name: 'AcqDate', label: 'Acquisition date', type: 'date', hidden: (v) => !!v.IsInternal || !v.AcqSalespersonID },
      { name: 'AcqRate', label: 'Acquisition commission rate', type: 'percent', hidden: (v) => !!v.IsInternal || !v.AcqSalespersonID, help: 'Stored with the acquisition; later changes to the salesperson’s default do not change it.' },
    ],
    initial: (base, ex) => {
      const a = ex ? app.idx.acqByClient.get(ex.ClientID) : null;
      Object.assign(base, { AcqSalespersonID: a?.SalespersonID ?? null, AcqDate: a?.AcquisitionDate ?? null, AcqRate: a?.AcquisitionRate ?? null });
    },
    onChange: (form, name) => {
      if (name !== 'AcqSalespersonID') return;
      const sp = app.idx.salespeople.get(Number(form.controls.AcqSalespersonID.input.value));
      if (!sp) return;
      if (!form.controls.AcqDate.input.value) form.setValue('AcqDate', todayISO());
      if (!form.controls.AcqRate.input.value) form.setValue('AcqRate', sp.CloseRate ?? 0);
    },
    validate: (d) => {
      if (d.IsInternal || !d.AcqSalespersonID) return {};
      const e = {};
      if (!d.AcqDate) e.AcqDate = 'Enter the acquisition date';
      if (d.AcqRate === null || d.AcqRate === undefined) e.AcqRate = 'Enter the acquisition rate';
      else if (!(d.AcqRate >= 0 && d.AcqRate <= 1)) e.AcqRate = 'Rate must be between 0% and 100%';
      return e;
    },
    beforeSubmit: async (d, ex) => {
      const a = ex ? app.idx.acqByClient.get(ex.ClientID) : null;
      if (!a || (!d.IsInternal && d.AcqSalespersonID)) return true;
      const s = acquisitionSummaries(app.idx).find((x) => x.acquisition.AcquisitionID === a.AcquisitionID);
      return confirmDialog(`Remove the acquisition record (${salespersonName(app.idx, a.SalespersonID)}, ${a.AcquisitionDate})? Its commission earned so far (${fmtMoney(s?.earned ?? Z())}) will no longer be counted, and ordinary Close commission applies again.`,
        { title: 'Remove acquisition?', ok: 'Remove acquisition', danger: true });
    },
    afterSave: async (saved, d) => {
      const a = app.idx.acqByClient.get(saved.ClientID);
      const sp = !d.IsInternal && d.AcqSalespersonID ? d.AcqSalespersonID : null;
      if (!sp) { if (a) await app.db.remove('acquisitions', a.AcquisitionID, a.revision); return; }
      const rec = { ...(a || blankRecord('acquisitions')), ClientID: saved.ClientID, SalespersonID: sp, AcquisitionDate: d.AcqDate, AcquisitionRate: d.AcqRate };
      if (!a) await app.db.create('acquisitions', rec);
      else if (a.SalespersonID !== sp || a.AcquisitionDate !== d.AcqDate || a.AcquisitionRate !== d.AcqRate) await app.db.update('acquisitions', rec, a.revision);
    },
  },

  sources: {
    store: 'sources', title: 'Acquisition Sources', addLabel: 'Add source', archivable: true,
    description: 'Where your clients come from, e.g. Fiverr, Upwork, LinkedIn or a referral. Choose a client’s source in the client form. Income is all paid income from the clients with that source.',
    describe: (r) => r.SourceName,
    columns: () => [
      { key: 'name', label: 'Source', type: 'text', strong: true },
      { key: 'clients', label: 'Clients', type: 'int', render: (r) => h('span', { class: `num-badge${r.clients ? ' brand' : ''}` }, String(r.clients)) },
      { key: 'clientNames', label: 'Client names', type: 'longtext' },
      { key: 'income', label: 'Income', type: 'money' },
      { key: 'notes', label: 'Notes', type: 'longtext' },
      { key: 'status', label: 'Status', type: 'text', align: 'center', render: (r) => (r._rec ? pill(r.status, r._rec.Archived ? 'neutral' : 'pos', true) : '') },
    ],
    rows: () => app.ds.sources.map((s) => {
      const clients = app.ds.clients.filter((c) => c.SourceID === s.SourceID);
      const ids = new Set(clients.map((c) => c.ClientID));
      const income = Dec.sum(app.ds.income.filter((i) => ids.has(clientIdOf(i.ProjectID))).map((i) => Dec.from(i.AmountPaid)));
      return { _rec: s, name: s.SourceName, clients: clients.length, clientNames: clients.map(clientLabel).sort().join(', '), income, notes: s.SourceNotes, status: s.Archived ? 'Archived' : 'Active' };
    }),
    totals: (rows) => ({ name: 'Total', clients: rows.reduce((n, r) => n + r.clients, 0), income: sum(rows, 'income') }),
    kpis: (rows) => {
      const active = app.ds.clients.filter((c) => !c.IsInternal && !c.Archived);
      const tagged = active.filter((c) => c.SourceID !== null && c.SourceID !== undefined).length;
      const top = [...rows].sort((a, b) => b.income.cmp(a.income))[0];
      return [
        { label: 'Sources', value: rows.length, unit: rows.length === 1 ? 'source' : 'sources', sub: 'Matching the current filters', icon: 'tag', tone: 'teal' },
        { label: 'Clients with a source', value: tagged, unit: `of ${active.length}`, sub: 'Active clients (internal not counted)', icon: 'users', tone: 'blue' },
        { label: 'Top source by income', value: top && !top.income.isZero() ? top.name : '—', sub: top && !top.income.isZero() ? fmtMoney(top.income) : 'No income recorded yet', icon: 'trend', tone: 'green' },
      ];
    },
    formFields: () => [
      { name: 'SourceName', label: 'Source name', type: 'text', required: true, wide: true, placeholder: 'e.g. Fiverr' },
      { name: 'SourceNotes', label: 'Notes', type: 'textarea' },
    ],
  },

  contracts: {
    store: 'contracts', title: 'Contracts', addLabel: 'Add contract', filters: ['client', 'status:Active|Upcoming|Ended|No clauses'], wideForm: true,
    description: 'Active contracts with existing clients. Each contract can have multiple clauses.',
    describe: (r) => `${clientNameById(app.idx, r.ClientID)} / ${r.ContractName}`,
    emptyText: 'No contracts yet. Use “Add contract” to record the first one, then add its clauses.',
    columns: () => [
      { key: 'client', label: 'Client', type: 'text', strong: true }, { key: 'name', label: 'Contract', type: 'text' }, { key: 'projects', label: 'Projects', type: 'longtext' },
      { key: 'status', label: 'Status', type: 'text', align: 'center', render: (r) => statusCell(r) }, { key: 'clauses', label: 'Clauses', type: 'text' },
      { key: 'decision', label: 'Next Approval Needed By', type: 'date' }, { key: 'end', label: 'Next End Date', type: 'date' },
      { key: 'charge', label: 'Income Received', type: 'money', title: 'Project Income of the covered projects during the contract period' }, { key: 'cost', label: 'Project Costs', type: 'money', title: 'Project Costs of the covered projects during the contract period' }, { key: 'margin', label: 'Margin', type: 'money', signed: true },
    ],
    rows: () => {
      const today = todayISO();
      return app.ds.contracts.map((c) => {
        const t = contractTotals(c, app.ds.clauses), a = contractActuals(c, app.ds), st = contractStatus(c, app.ds.clauses, today), next = nextContractDates(c, app.ds.clauses, today);
        const u = contractUrgency(c, app.ds.clauses, today), due = u.level ? ` · ${urgencyNote(u)}` : '';
        return { _rec: c, kind: u.level ? `renew-${u.level}` : null, urgency: u.level ? { level: u.level, note: urgencyNote(u) } : null, clientId: c.ClientID, contractId: c.ContractID, client: clientNameById(app.idx, c.ClientID), name: c.ContractName,
          projects: contractProjects(c).map((pid) => app.idx.projects.get(pid)?.ProjectName ?? `#${pid}`).join(', '),
          status: st + due, statusKey: st, clauses: t.clauseCount ? `${t.clauseCount} (${next.activeCount} active)` : '0', clauseCount: t.clauseCount, decision: next.decision, end: next.end, charge: a.income, cost: a.cost, margin: a.margin };
      });
    },
    totals: (rows) => ({ client: 'Total', charge: sum(rows, 'charge'), cost: sum(rows, 'cost'), margin: sum(rows, 'margin') }),
    kpis: (rows) => {
      const active = rows.filter((r) => r.statusKey === 'Active').length;
      return [
        { label: 'Active contracts', value: active, unit: `of ${rows.length}`, sub: rows.length ? `${Math.round((active / rows.length) * 100)}% active · ${plural(rows.filter((r) => r.urgency).length, 'renewal')} due soon` : 'No contracts', icon: 'contract', tone: 'teal' },
        ...moneyKpis(rows, 'Income received', 'Project Income during the contract periods', 'Project costs', 'Project Costs during the contract periods', 'Income minus project costs'),
      ];
    },
    rowActions: (row) => h('button', { type: 'button', class: 'btn btn-small btn-tinted', onclick: () => { location.hash = `#/clauses?contract=${row.contractId}`; }, 'aria-label': `Clauses of ${row.name}` }, icon.list(), ` Clauses (${row.clauseCount})`),
    defaults: (st) => ({ ClientID: st.clientId ?? null }),
    formFields: (ex) => [
      { name: 'ClientID', label: 'Client', type: 'select', required: true, options: () => clientOptions(ex?.ClientID, { nonInternal: true }) },
      { name: 'ProjectIDs', label: 'Projects covered', type: 'tags', asText: true, wide: true, required: true, restrictToOptions: true, labelOf: (id) => projectLabel(app.idx, id),
        options: (v) => (v.ClientID ? projectOptions(null, { clientId: v.ClientID, includeHidden: true }) : []),
        help: 'Choose from the client’s existing projects (add new ones under Projects). Their income and costs make up the contract’s figures. When every contract of a project has ended, the project is hidden like an archived one.' },
      { name: 'ContractName', label: 'Contract name (optional)', type: 'text', wide: true, help: 'Leave blank to use the project names.' },
      { name: 'ContractNotes', label: 'Notes', type: 'textarea' },
    ],
    formIntro: (ex) => h('p', { class: 'note note-info' }, ex ? 'Dates and renewal notice are on this contract’s clauses (Clauses button on the Contracts list). Income and costs come from the projects.' : 'After saving, add the contract’s clauses with their dates (Clauses button on the Contracts list). Income and costs come from the projects.'),
    // At least one project (older contracts without any are kept until edited); a blank name becomes the project names.
    validate: (d) => (parseIdList(d.ProjectIDs).length ? null : { ProjectIDs: 'Choose at least one of the client’s projects' }),
    prepare: (d) => { if (!String(d.ContractName ?? '').trim() && parseIdList(d.ProjectIDs).length) d.ContractName = parseIdList(d.ProjectIDs).map((id) => app.idx.projects.get(id)?.ProjectName ?? `#${id}`).join(' + ').slice(0, 160); },
    onChange: (form, name) => { if (name === 'ClientID') form.refreshOptions(); },
    preview: (d, ex) => {
      if (!parseIdList(d.ProjectIDs).length) return null;
      const today = todayISO(), c = { ...(ex || {}), ContractID: ex?.ContractID ?? -1, ProjectIDs: d.ProjectIDs };
      const t = contractTotals(c, app.ds.clauses), next = nextContractDates(c, app.ds.clauses, today), a = contractActuals(c, app.ds);
      if (!ex) return preview('From the chosen projects', pv('Period counted', 'All dates (until clauses are added)'), pv('Income received', fmtMoney(a.income)), pv('Project costs', fmtMoney(a.cost)), pv('Margin', fmtMoney(a.margin), 'pv-strong'));
      return preview('Contract summary',
        pv('Status today', contractStatus(ex, app.ds.clauses, today)),
        pv('Clauses', `${t.clauseCount} (${next.activeCount} active)`),
        pv('Next client approval needed by', next.decision ?? '—'), pv('Next end date', next.end ?? '—'),
        pv('Period counted', a.from ? `${a.from} → ${a.to ?? 'ongoing'}` : 'All dates (no clauses yet)'),
        pv('Income received', fmtMoney(a.income)), pv('Project costs', fmtMoney(a.cost)),
        pv('Margin', fmtMoney(a.margin), `pv-strong ${a.margin.round(2).sign() < 0 ? 'neg' : ''}`));
    },
  },

  clauses: {
    store: 'clauses', title: 'Contract Clauses', addLabel: 'Add clause', filters: ['client', 'contract', 'status:Active|Upcoming|Ended', 'date'], dateLabel: 'start date', wideForm: true,
    description: 'The clauses of each contract: what the client is charged, what Engineered Plans is charged, and how long each runs. The end date is the start date plus the term; the renewal notice period is how long before the end date the client must approve a renewal.',
    describe: (r) => r.ClauseTitle,
    emptyText: 'No clauses yet. Use “Add clause”, or open a contract’s Clauses button.',
    columns: () => [
      { key: 'contract', label: 'Client / Contract', type: 'text', render: (r) => (!r._rec || r.contractName === null ? r.contract : h('span', {}, h('span', { class: 'cell-main' }, r.clientName), h('span', { class: 'cell-sub' }, ` / ${r.contractName}`))) },
      { key: 'title', label: 'Clause', type: 'text', strong: true },
      { key: 'date', label: 'Start', type: 'date' }, { key: 'term', label: 'Term', type: 'text' }, { key: 'end', label: 'End', type: 'date' },
      { key: 'notice', label: 'Renewal Notice', type: 'text' }, { key: 'decision', label: 'Approval Needed By', type: 'date' },
      { key: 'status', label: 'Status', type: 'text', align: 'center', render: (r) => statusCell(r) },
      { key: 'details', label: 'Details', type: 'longtext' },
    ],
    rows: () => {
      const today = todayISO();
      return app.ds.clauses.map((x) => {
        const c = app.ds.contracts.find((k) => k.ContractID === x.ContractID);
        const charge = x.ChargeToClient === null ? null : Dec.from(x.ChargeToClient), cost = x.CostToEngineeredPlans === null ? null : Dec.from(x.CostToEngineeredPlans);
        const st = clauseStatus(x, today), decision = renewalDecisionDate(x);
        const u = renewalUrgency(x, today), due = u.level ? ` · ${urgencyNote(u)}` : '';
        return { _rec: x, contractId: x.ContractID, clientId: c?.ClientID ?? null, contract: c ? `${clientNameById(app.idx, c.ClientID)} / ${c.ContractName}` : `Missing contract #${x.ContractID}`,
          clientName: c ? clientNameById(app.idx, c.ClientID) : null, contractName: c ? c.ContractName : null,
          kind: u.level ? `renew-${u.level}` : null, // row highlight: yellow within a month, red within a week / overdue
          urgency: u.level ? { level: u.level, note: urgencyNote(u) } : null,
          title: x.ClauseTitle, date: x.StartDate, term: termLabel(x), end: clauseEndDate(x), notice: noticeLabel(x), decision, status: st + due, statusKey: st,
          details: x.ClauseDetails, charge, cost, margin: (charge ?? Z()).sub(cost ?? Z()) };
      });
    },
    kpis: (rows) => {
      const active = rows.filter((r) => r.statusKey === 'Active').length;
      return [
        { label: 'Total clauses', value: rows.length, unit: rows.length === 1 ? 'clause' : 'clauses', sub: `${active} active${rows.length ? ` · ${Math.round((active / rows.length) * 100)}%` : ''}`, icon: 'file', tone: 'slate' },
        ...renewalKpis(rows),
      ];
    },
    intro: () => h('a', { class: 'back-link no-print', href: '#/contracts' }, icon.chevronLeft(), 'All contracts'),
    defaults: (st) => ({ ContractID: st.contractId ?? null, StartDate: todayISO() }),
    formFields: (ex) => [
      { name: 'ContractID', label: 'Contract', type: 'select', required: true, wide: true, options: () => contractOptions() },
      { name: 'ClauseTitle', label: 'Clause', type: 'text', required: true, wide: true, help: 'e.g. Website hosting, Domain renewal, Monthly content updates' },
      { name: 'StartDate', label: 'Start date', type: 'date', required: true },
      { name: 'EndPreview', label: 'End date (calculated)', type: 'text', readonly: true, help: 'Start date + term below.' },
      { name: 'TermYears', label: 'Term: years', type: 'number', help: 'e.g. 2 years, or 1 year + 6 months.' },
      { name: 'TermMonths', label: 'Term: months', type: 'number', help: 'Leave both blank if it runs until cancelled.' },
      { name: 'RenewalNoticeCount', label: 'Renewal notice period', type: 'number', help: 'How long before the end date the client must approve a renewal.' },
      { name: 'RenewalNoticeUnit', label: 'Notice unit', type: 'select', numeric: false, placeholder: '—', options: () => NOTICE_UNITS.map((u) => ({ value: u, label: `${u}s` })) },
      { name: 'ChargeToClient', label: 'Agreed charge to client (reference)', type: 'money', help: 'For reference only: contract figures come from the projects’ income and costs.' },
      { name: 'CostToEngineeredPlans', label: 'Expected cost to Engineered Plans (reference)', type: 'money', help: 'e.g. hosting or domain. For reference only.' },
      { name: 'ClauseDetails', label: 'Details', type: 'textarea' },
    ],
    // Shows the calculated end date in its (read-only) field when the editor opens and whenever start or term change.
    onInit: (form) => CONFIGS.clauses.onChange(form),
    onChange: (form) => {
      const { values } = form.values();
      const end = clauseEndDate(values);
      form.controls.EndPreview.input.value = values.StartDate ? (end ?? 'Until cancelled') : '';
    },
    preview: (d) => {
      if (!d.StartDate) return null;
      const end = clauseEndDate(d), decision = renewalDecisionDate(d);
      const z = (v) => (v === null || v === undefined ? Z() : Dec.from(v));
      return preview('Clause summary',
        pv('Runs', end ? `${d.StartDate} → ${end} (${termLabel(d)})` : `From ${d.StartDate}, until cancelled`, 'pv-strong'),
        pv('Client approval needed by', decision ? `${decision} (${noticeLabel(d)} before ${end})` : end ? 'Enter a notice period' : 'No end date'),
        pv('Status today', clauseStatus(d, todayISO())),
        pv('Margin', fmtMoney(z(d.ChargeToClient).sub(z(d.CostToEngineeredPlans)))));
    },
  },

  projects: {
    store: 'projects', title: 'Projects', addLabel: 'Add project', archivable: true, filters: ['client', 'type:Client|Internal'],
    archivedLabel: 'Show archived and ended-contract projects',
    description: 'Client projects and internal cost centres. Internal cost centres carry a stable company cost category, so renaming them never removes costs from the company totals. A project whose contracts have all ended is hidden like an archived project (add it to a new contract to bring it back).',
    describe: (r) => projectLabel(app.idx, r.ProjectID),
    columns: () => [
      { key: 'client', label: 'Client', type: 'text' }, { key: 'name', label: 'Project', type: 'text' },
      { key: 'type', label: 'Type', type: 'text', render: (r) => pill(r.type, r.type === 'Internal' ? 'warn' : 'brand') },
      { key: 'category', label: 'Company cost category', type: 'text' },
      { key: 'contracts', label: 'Contracts', type: 'text', render: (r) => (r.contractList.length ? h('span', { class: 'chip-list' }, r.contractList.map((c) => h('a', { class: 'chip', href: `#/clauses?contract=${c.id}`, title: `Open the clauses of ${c.name}` }, c.name, ' ', h('span', { class: `chip-status chip-${c.status.toLowerCase().replace(/\s+/g, '-')}` }, `(${c.status.toLowerCase()})`)))) : h('span', { class: 'muted' }, '—')) },
      { key: 'status', label: 'Status', type: 'text', render: (r) => pill(r.status, PROJECT_STATUS_TONE[r.status] || 'neutral', true) },
    ],
    kpis: (rows) => {
      const client = rows.filter((r) => r.type === 'Client').length, active = rows.filter((r) => r.status === 'Active').length;
      const ids = new Set(rows.map((r) => r.projectId)), today = todayISO();
      const linked = app.ds.contracts.filter((c) => contractProjects(c).some((pid) => ids.has(pid)));
      const activeLinked = linked.filter((c) => contractStatus(c, app.ds.clauses, today) === 'Active').length;
      return [
        { label: 'Total projects', value: rows.length, pill: rows.length ? `${Math.round((100 * active) / rows.length)}% active` : null, icon: 'clipboard', tone: 'slate' },
        { label: 'Client projects', value: client, unit: 'Billable accounts', icon: 'users', tone: 'teal' },
        { label: 'Internal cost centres', value: rows.length - client, unit: 'Operational units', icon: 'building', tone: 'amber' },
        { label: 'Contracts linked', value: linked.length, unit: linked.length === 1 ? 'contract' : 'contracts', pill: activeLinked ? (activeLinked === linked.length ? 'All active' : `${activeLinked} active`) : null, sub: linked.length && !activeLinked ? 'None active' : null, icon: 'trend', tone: 'green' },
      ];
    },
    isHidden: (r) => !!projectHiddenReason(r._rec),
    rows: () => app.ds.projects.map((p) => {
      const why = projectHiddenReason(p);
      const mine = app.ds.contracts.filter((c) => contractProjects(c).includes(p.ProjectID));
      const today = todayISO();
      return { _rec: p, projectId: p.ProjectID, clientId: p.ClientID, client: clientNameById(app.idx, p.ClientID), name: p.ProjectName, type: p.ProjectType, category: p.ProjectType === 'Client' ? 'Client Project Costs' : (CATEGORY_BY_CODE[p.CategoryCode]?.name ?? 'Other Internal Costs'),
        contracts: mine.map((c) => `${c.ContractName} (${contractStatus(c, app.ds.clauses, today).toLowerCase()})`).join(', '),
        contractList: mine.map((c) => ({ id: c.ContractID, name: c.ContractName, status: contractStatus(c, app.ds.clauses, today) })),
        status: projectStatus(p, why, mine.map((c) => contractStatus(c, app.ds.clauses, today))) };
    }),
    defaults: () => ({ ProjectType: 'Client' }),
    formFields: (ex) => [
      { name: 'ClientID', label: 'Client', type: 'select', required: true, options: () => clientOptions(ex?.ClientID) },
      { name: 'ProjectName', label: 'Project name', type: 'text', required: true },
      { name: 'ProjectType', label: 'Project type', type: 'select', required: true, numeric: false, options: () => [{ value: 'Client', label: 'Client' }, { value: 'Internal', label: 'Internal' }], help: 'Set automatically from the client: internal client → Internal, other clients → Client.' },
      { name: 'CategoryCode', label: 'Company cost category', type: 'select', numeric: false, hidden: (v) => v.ProjectType !== 'Internal', hiddenValue: null, placeholder: 'Other Internal Costs (no fixed category)', options: () => COST_CATEGORIES.map((c) => ({ value: c.code, label: c.name })), help: 'Used by Company Totals. Each internal cost is counted exactly once.' },
    ],
    onChange: (form, name) => {
      if (name !== 'ClientID') return;
      const c = app.idx.clients.get(Number(form.controls.ClientID.input.value));
      if (c) form.setValue('ProjectType', c.IsInternal ? 'Internal' : 'Client');
    },
  },

  people: {
    store: 'people', title: 'Employees & Rates', addLabel: 'Add employee', archivable: true,
    description: 'Employees, their monthly salary and rates. From the join date, the salary is added automatically as a cost under Team Salaries (or Owners Salary) on the last day of each month worked, including the join and leave months (always the full salary; no partial months). The default hourly value (salary ÷ reference hours) is used for time value.',
    describe: (r) => r.PersonName,
    columns: () => [
      { key: 'name', label: 'Employee', type: 'text' }, { key: 'monthly', label: 'Monthly Salary', type: 'money' },
      { key: 'join', label: 'Join Date', type: 'date' }, { key: 'leave', label: 'Leave Date', type: 'date' }, { key: 'centre', label: 'Charged To', type: 'text' },
      { key: 'hours', label: 'Reference Hours', type: 'hours' }, { key: 'hourly', label: 'Default Hourly Value', type: 'money' },
      { key: 'notes', label: 'Rate Notes', type: 'longtext' }, { key: 'status', label: 'Status', type: 'text' },
    ],
    rows: () => {
      const today = todayISO();
      return app.ds.people.map((p) => ({ _rec: p, personId: p.PersonID, name: p.PersonName, monthly: p.MonthlyReferenceValue, join: p.JoinDate ?? null, leave: p.LeaveDate ?? null,
        centre: p.IsOwner ? 'Owners Salary (recorded by hand)' : CATEGORY_BY_CODE[p.SalaryCategory || 'TEAM_SALARIES'].name, hours: p.ReferenceHours, hourly: defaultHourly(p), notes: p.RateNotes,
        status: p.Archived ? 'Archived' : p.IsOwner ? 'Owner' : !p.JoinDate ? 'Active · no join date (salary not paid)' : p.LeaveDate && p.LeaveDate < today ? 'Left' : p.JoinDate > today ? 'Joins later' : 'Active' }));
    },
    formIntro: (ex) => ex ? h('p', { class: 'note note-warning' }, 'A new salary applies to months not yet added; salary entries already added stay as they are. Changing the join or leave date adds or removes whole months you have not edited. Changing the salary or reference hours also recalculates the time value of past time entries without a rate override (there is no rate history).') : null,
    formFields: () => [
      { name: 'PersonName', label: 'Employee name', type: 'text', required: true, wide: true },
      { name: 'IsOwner', label: 'This is the company owner', type: 'checkbox', wide: true, help: 'Owners need no join or leave date, and no salary entries are added automatically: record the owner salary you actually take under Project Costs → Owners Salary. The monthly salary is still used for the hourly value.' },
      { name: 'MonthlyReferenceValue', label: 'Monthly salary', type: 'money', required: true, help: 'Paid in full for every complete month worked. 0 = no salary entries.' },
      { name: 'SalaryCategory', label: 'Charge salary to', type: 'select', numeric: false, placeholder: 'Team Salaries (default)', options: () => [{ value: 'OWNERS_SALARY', label: 'Owners Salary' }], hidden: (v) => !!v.IsOwner, hiddenValue: null },
      { name: 'JoinDate', label: 'Join date', type: 'date', required: true, help: 'Paid from this day (inclusive).', hidden: (v) => !!v.IsOwner, hiddenValue: null },
      { name: 'LeaveDate', label: 'Leave date (optional)', type: 'date', help: 'Last day worked (inclusive). The leave month is paid in full.', hidden: (v) => !!v.IsOwner, hiddenValue: null },
      { name: 'ReferenceHours', label: 'Reference hours per month', type: 'number', required: true, help: 'Must be greater than zero. Used for the default hourly value.' },
      { name: 'RateNotes', label: 'Rate notes', type: 'textarea' },
      { name: 'BankName', label: 'Bank name (confidential, optional)', type: 'text' },
      { name: 'AccountName', label: 'Account holder name (optional)', type: 'text', help: 'May differ from the employee name.' },
      { name: 'IBAN', label: 'IBAN / account number (optional)', type: 'text', mono: true, wide: true },
    ],
    preview: (d, ex) => {
      const hr = d.MonthlyReferenceValue != null && d.ReferenceHours > 0 ? Dec.from(d.MonthlyReferenceValue).div(Dec.from(d.ReferenceHours), 10) : null;
      const hourly = pv('Default hourly value', hr === null ? 'Enter a salary and reference hours > 0' : `${fmtMoney(hr)} / hour`);
      if (d.IsOwner) return preview('Calculated', hourly, pv('Salary entries', 'None added automatically (owner)'), ex && salaryRuleOf(ex, app.ds.recurring) ? h('p', { class: 'note note-info' }, 'The salary schedule this person had is paused. Salary entries already added stay as they are.') : null);
      if (!paysSalary(d) || (d.LeaveDate && d.LeaveDate < d.JoinDate)) return preview('Calculated', hourly, pv('Salary entries', d.JoinDate ? 'None (salary is 0)' : 'Enter the join date and monthly salary'));
      const existing = ex ? salaryRuleOf(ex, app.ds.recurring) : null;
      const rule = salaryRuleFor({ ...d, PersonID: ex?.PersonID ?? -1, Archived: ex?.Archived ?? null }, existing, app.ds.projects);
      const today = todayISO();
      const pay = (date) => { const a = occurrenceAmount(rule, date); return `${fmtMoney(a.amount)} on ${date}${a.partial ? ` — ${a.covered} of ${a.period} days` : ''}`; };
      const first = nthOccurrence(rule, 0);
      const all = d.LeaveDate ? occurrencesBetween(rule, null, endBound(rule)) : null;
      const last = all && all.length > 1 ? all[all.length - 1] : null;
      const due = existing && existing.StartDate === rule.StartDate ? dueOccurrences(rule, today) : occurrencesBetween({ ...rule, GeneratedThrough: null }, null, horizonFor(today));
      const past = due.filter((x) => x < today);
      // Hand-made recurring rules that look like this employee's salary would pay it twice.
      const name = (d.PersonName || '').trim().toLowerCase();
      const dupes = name ? app.ds.recurring.filter((r) => !isSalary(r) && r.Kind === 'Cost' && !r.Archived && (!r.EndDate || r.EndDate >= d.JoinDate) && r.Name.toLowerCase().includes(name)) : [];
      return preview('Salary (preview — nothing is added until you press Submit)',
        hourly,
        pv('Charged to', CATEGORY_BY_CODE[d.SalaryCategory || 'TEAM_SALARIES'].name),
        pv('First month', pay(first), occurrenceAmount(rule, first).partial ? 'pv-strong' : ''),
        pv('Every full month', `${fmtMoney(rule.Amount)} on the last day of the month`),
        last ? pv('Last month', pay(last), occurrenceAmount(rule, last).partial ? 'pv-strong' : '') : null,
        !existing || existing.StartDate !== rule.StartDate ? pv('Added when you press Submit', due.length ? `${due.length} salary entr${due.length === 1 ? 'y' : 'ies'}, total ${fmtMoney(Dec.sum(due.map((x) => occurrenceAmount(rule, x).amount)))}` : 'None yet (the first month end is more than 14 days away)') : null,
        !existing && past.length ? h('p', { class: 'note note-warning' }, `${past.length} past month${past.length === 1 ? ' is' : 's are'} added as salary costs. If you already recorded ${past.length === 1 ? 'it' : 'them'} by hand under Project Costs, delete those entries so the salary is not counted twice.`) : null,
        dupes.length ? h('p', { class: 'note note-warning' }, `Recurring cost${dupes.length === 1 ? '' : 's'} ${dupes.map((r) => `“${r.Name}”`).join(', ')} may already pay this salary. End or delete ${dupes.length === 1 ? 'it' : 'them'} under Recurring so the salary is not paid twice.`) : null);
    },
    afterSave: async (saved) => {
      const a = saved?._adjusted;
      if (a && (a.updated || a.deleted || a.skipped || a.created)) toast(`Salary entries corrected for the new dates: ${a.updated} adjusted, ${a.deleted} removed${a.created ? `, ${a.created} added` : ''}${a.skipped ? `, ${a.skipped} edited by hand left unchanged` : ''}.`, a.skipped ? 'warn' : 'ok', 9000);
      return app.runRecurring?.();
    },
  },

  salespeople: {
    store: 'salespeople', title: 'Salespeople', addLabel: 'Add sales profile', archivable: true,
    description: 'Sales profiles linked to employees: default close commission rate and fee per attended meeting. Defaults are read live, so changing them affects past activities without overrides (as in Access).',
    describe: (r) => salespersonName(app.idx, r.SalespersonID),
    columns: () => [
      { key: 'name', label: 'Salesperson', type: 'text', render: (r) => r._rec ? h('div', { class: 'person-cell' },
        h('span', { class: 'avatar', 'aria-hidden': 'true' }, initials(r.name)),
        h('div', {}, h('a', { href: `#/activities?salesperson=${r.spId}`, title: `Show employee activities of ${r.name}` }, r.name), h('div', { class: 'person-sub' }, r._rec.Archived ? 'Archived' : `Employee #${r.personId}`))) : r.name },
      { key: 'rate', label: 'Close Rate', type: 'rate' }, { key: 'fee', label: 'Meeting Fee', type: 'money' },
      { key: 'closed', label: 'Total Closed (all time)', type: 'money', strong: true, title: 'Sales value closed: paid amount credited on Close activities + client income inside an acquisition’s 180-day window' }, { key: 'paidOut', label: 'Paid Out', type: 'money' },
      { key: 'owed', label: 'Owed', type: 'money', signed: true, render: (r) => (r._rec && r.owed && r.owed.round(2).sign() > 0 ? pill(fmtMoney(r.owed), 'warn') : fmtMoney(r.owed)) },
    ],
    // All-time figures of the profiles shown (archived ones only when "Show archived" is ticked).
    kpis: (rows) => {
      const owed = sum(rows, 'owed');
      const unpaid = rows.filter((r) => r.owed && r.owed.round(2).sign() > 0).length;
      return [
        { label: 'Sales profiles', value: rows.length, unit: rows.length === 1 ? 'salesperson' : 'salespeople', sub: `${plural(rows.filter((r) => !r._rec.Archived).length, 'active profile')}`, icon: 'users', tone: 'slate' },
        { label: 'Total closed (all time)', value: fmtMoney(sum(rows, 'closed')), sub: 'Sales value closed by salespeople', icon: 'trend', tone: 'blue' },
        { label: 'Total paid out', value: fmtMoney(sum(rows, 'paidOut')), sub: 'Recorded sales payouts', icon: 'checkCircle', tone: 'violet' },
        { label: 'Outstanding owed', value: fmtMoney(owed), valueTone: owed.round(2).sign() < 0 ? 'neg' : '', sub: unpaid ? `${plural(unpaid, 'salesperson', 'salespeople')} awaiting payout` : 'Nothing awaiting payout', subTone: unpaid ? 'warn' : '', icon: 'money', tone: 'amber', highlight: unpaid ? 'warn' : null },
      ];
    },
    rows: () => { const s = new Map(salesSummary(app.idx).map((r) => [r.spId, r])); return app.ds.salespeople.map((sp) => ({ _rec: sp, spId: sp.SalespersonID, personId: sp.PersonID, name: salespersonName(app.idx, sp.SalespersonID), rate: sp.CloseRate, fee: sp.MeetingFee, earned: s.get(sp.SalespersonID)?.earned, closed: s.get(sp.SalespersonID)?.credited, paidOut: s.get(sp.SalespersonID)?.paidOut, owed: s.get(sp.SalespersonID)?.owed })); },
    totals: (rows) => ({ name: 'Total', rate: null, fee: null, closed: sum(rows, 'closed'), paidOut: sum(rows, 'paidOut'), owed: sum(rows, 'owed') }),
    formIntro: (ex) => ex ? h('p', { class: 'note note-warning' }, 'Changing the default close rate or meeting fee changes the earnings of past activities that have no override.') : null,
    formFields: (ex) => [
      { name: 'PersonID', label: 'Employee', type: 'select', required: true, options: () => personOptions(ex?.PersonID).filter((o) => o.value === ex?.PersonID || !app.ds.salespeople.some((s) => s.PersonID === o.value)), help: 'Each employee can have one sales profile.' },
      { name: 'CloseRate', label: 'Default close rate', type: 'percent', required: true, help: 'Enter 5 for 5% (stored as 0.05).' },
      { name: 'MeetingFee', label: 'Fee per attended meeting', type: 'money', required: true },
    ],
  },

  income: {
    store: 'income', title: 'Project Income', addLabel: 'Add income', filters: ['client', 'project', 'date'], dateLabel: 'start date',
    description: 'Amounts actually paid (not invoices or contract values). The full amount counts in the month of its start date; the end date only describes the period covered.',
    describe: (r) => `${projectLabel(app.idx, r.ProjectID)} ${r.StartDate} ${fmtMoney(r.AmountPaid)}`,
    columns: () => [
      { key: 'date', label: 'Start Date', type: 'date' }, { key: 'end', label: 'End Date', type: 'date' },
      { key: 'client', label: 'Client', type: 'text' }, { key: 'project', label: 'Project', type: 'text' },
      { key: 'amount', label: 'Amount Paid', type: 'money' }, { key: 'original', label: 'Original Currency', type: 'text', render: (r) => fxCell(r._rec) }, filesColumn('income'), { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    rows: () => { const n = attachmentCounts('income'); return app.ds.income.map((i) => ({ _rec: i, files: n.get(i.IncomeID) || 0, original: fxText(i), date: i.StartDate, end: i.EndDate, projectId: i.ProjectID, clientId: clientIdOf(i.ProjectID), client: cname(i.ProjectID), project: pname(i.ProjectID), amount: Dec.from(i.AmountPaid), notes: withRepeats(i.IncomeNotes, repeatsLabel(i)) })); },
    totals: (rows) => ({ date: 'Total', amount: sum(rows, 'amount') }),
    badge: 'Cash basis',
    kpis: (rows) => {
      const total = sum(rows, 'amount');
      return [
        { label: 'Total income received', value: fmtMoney(total), sub: `From ${plural(new Set(rows.map((r) => r.clientId)).size, 'client')}`, icon: 'money', tone: 'teal' },
        { label: 'Total paid records', value: rows.length, unit: 'Transactions', sub: `Across ${plural(new Set(rows.map((r) => r.projectId)).size, 'project')}`, icon: 'file', tone: 'blue' },
        { label: 'Average payment', value: rows.length ? fmtMoney(total.div(Dec.from(rows.length), 10)) : '—', sub: 'Mean payment value', icon: 'bars', tone: 'indigo' },
        incomePerDay(rows),
      ];
    },
    defaults: () => ({ StartDate: todayISO() }),
    formFields: (ex) => [
      { name: 'ProjectID', label: 'Project', type: 'select', required: true, wide: true, options: () => projectOptions(ex?.ProjectID) },
      { name: 'StartDate', label: 'Start date', type: 'date', required: true, help: 'The whole amount is reported in this month.' },
      { name: 'EndDate', label: 'End date (optional)', type: 'date', help: 'Descriptive only — no prorating.' },
      ...fxFields(ex, { name: 'AmountPaid', label: 'Amount paid', type: 'money', required: true }),
      { name: 'IncomeNotes', label: 'Notes', type: 'textarea' },
    ],
    initial: fxInitial,
    onInit: (form) => fxSuffixes(form),
    onChange: (form) => fxSuffixes(form),
    prepare: (d, ex) => fxPrepare('income', d, ex),
    validate: fxValidate,
    beforeSubmit: (d) => fxBeforeSubmit('income', d),
    preview: (d) => fxPreview('income', d),
    ...attachHooks('income'),
  },

  timeEntries: {
    store: 'timeEntries', title: 'Time Entries', addLabel: 'Add time entry', hideAdd: true, // the timer bar adds entries
    filters: ['client', 'project', 'person', 'date'], dateLabel: 'work date', wideForm: true,
    description: 'Hours worked, in decimal hours (24.07 = 24.07 hours). All hours worked are billed. Use the timer below to track time live or add it manually. Time value is analytical and never reduces the actual result.',
    chart: weekChart,
    listView: timeList,
    badge: 'Decimal hours',
    kpis: (rows, all, { filters: st = {} } = {}) => {
      const worked = hoursOf(rows, 'worked'), value = sum(rows, 'value');
      // Paid income in the same client / project / date scope as the hours (search and employee do not apply to income).
      const income = sum(app.ds.income.filter((i) => inRange(i.StartDate, st.from, st.to) && (!st.projectId || i.ProjectID === st.projectId) && (!st.clientId || app.idx.projects.get(i.ProjectID)?.ClientID === st.clientId)).map((i) => ({ a: Dec.from(i.AmountPaid) })), 'a');
      // Weeks run Sunday to Saturday (as in the list); only weeks with at least one entry count.
      const weeks = new Set(rows.filter((r) => r.date).map((r) => addDays(r.date, -new Date(r.date + 'T00:00:00Z').getUTCDay()))).size;
      const valued = hoursOf(rows.filter((r) => r.value), 'worked');
      return [
        { label: 'Total hours worked', value: fmtHours(worked.round(2)), unit: 'hours', sub: plural(new Set(rows.map((r) => r.personId)).size, 'team member'), icon: 'clock', tone: 'teal' },
        { label: 'Average per week', value: weeks ? fmtHours(worked.div(weeks, 4).round(2)) : '—', unit: 'hours', sub: `Over ${plural(weeks, 'week')} with time logged`, icon: 'calendar', tone: 'green' },
        { label: 'Total time value', value: fmtMoney(value), sub: valued.isZero() ? 'Analytical only' : `${fmtMoney(value.div(valued, 10))} average per hour worked`, icon: 'money', tone: 'blue' },
        { label: 'Paid per billable hour', value: worked.isZero() ? '—' : fmtMoney(income.div(worked, 10)), sub: `${fmtMoney(income)} income ÷ ${fmtHours(worked.round(2))} h`, icon: 'payments', tone: 'violet' },
      ];
    },
    filterSummary: (rows) => [
      h('span', { class: 'fs-count' }, `${plural(rows.length, 'record')} found`),
      h('span', { class: 'fs-totals' },
        h('span', {}, 'Hours worked: ', h('strong', {}, `${fmtHours(hoursOf(rows, 'worked').round(2))} h`)),
        h('span', { class: 'fs-sep', 'aria-hidden': 'true' }, '|'),
        h('span', {}, 'Time value: ', h('strong', {}, fmtMoney(sum(rows, 'value'))))),
    ],
    describe: (r) => `${r.WorkDate} ${personName(app.idx, r.PersonID)} ${fmtHours(r.HoursWorked)} h`,
    columns: () => [
      { key: 'date', label: 'Work Date', type: 'date' }, { key: 'project', label: 'Client / Project', type: 'text' }, { key: 'employee', label: 'Employee', type: 'text' },
      { key: 'task', label: 'Task', type: 'longtext' }, { key: 'worked', label: 'Hours', type: 'hours' },
      { key: 'hourly', label: 'Hourly Value', type: 'money' }, { key: 'value', label: 'Time Value', type: 'money' },
    ],
    rows: () => app.ds.timeEntries.map((t) => { const v = timeEntryValue(t, app.idx.people.get(t.PersonID)); return { _rec: t, date: t.WorkDate, projectId: t.ProjectID, clientId: clientIdOf(t.ProjectID), personId: t.PersonID, project: projectLabel(app.idx, t.ProjectID), employee: personName(app.idx, t.PersonID), task: t.WorkTask, worked: t.HoursWorked, hourly: v.hourly, value: v.value }; }),
    totals: (rows) => ({ date: 'Total', worked: sum(rows.map((r) => ({ w: r.worked === null ? null : Dec.from(r.worked) })), 'w'), value: sum(rows, 'value') }),
    defaults: () => ({ WorkDate: todayISO() }),
    prepare: (r) => { r.HoursBilled = r.HoursWorked; }, // all hours worked are billed
    intro: timeTracker,
    formFields: (ex) => [
      { name: 'WorkDate', label: 'Work date', type: 'date', required: true },
      { name: 'PersonID', label: 'Employee', type: 'select', required: true, options: () => personOptions(ex?.PersonID) },
      { name: 'ProjectID', label: 'Project', type: 'select', required: true, wide: true, options: () => projectOptions(ex?.ProjectID) },
      { name: 'WorkTask', label: 'Task', type: 'text', wide: true },
      { name: 'HoursWorked', label: 'Hours worked', type: 'hours', required: true, help: 'All hours worked are billed.' },
      { name: 'RateOverride', label: 'Hourly value override (optional)', type: 'money', unit: `${BASE_SYMBOL}/hour`, help: 'Leave blank to use the employee default. 0 is a real override (zero value).' },
    ],
    preview: (d) => {
      const person = app.idx.people.get(d.PersonID);
      const v = timeEntryValue({ ...d, HoursWorked: d.HoursWorked ?? null }, person);
      return preview('Live preview (not saved yet)',
        pv('Effective hourly value', v.hourly === null ? (person ? 'Employee has no valid reference value/hours' : 'Choose an employee') : `${fmtMoney(v.hourly)} / hour${v.overridden ? ' (override)' : ' (employee default)'}`),
        pv('Analytical time value', v.value === null ? '—' : fmtMoney(v.value)));
    },
  },

  costs: {
    store: 'costs', title: 'Project Costs', addLabel: 'Add cost', filters: ['client', 'project', 'date'], dateLabel: 'start date',
    description: 'Actual expenses: project costs, subscriptions, equipment, bank fees, lead acquisition, team salaries and owner salary. The full amount counts on its start date; no automatic spreading or recurring bills.',
    describe: (r) => `${projectLabel(app.idx, r.ProjectID)} ${r.CostItem ?? ''} ${fmtMoney(r.CostAmount)}`,
    columns: () => [
      { key: 'date', label: 'Start Date', type: 'date' }, { key: 'end', label: 'End Date', type: 'date' },
      { key: 'project', label: 'Client / Project', type: 'text' }, { key: 'item', label: 'Item', type: 'text' },
      { key: 'amount', label: 'Cost Amount', type: 'money', strong: true }, { key: 'original', label: 'Original Currency', type: 'text', render: (r) => (r._rec ? fxCell(r._rec) : '') }, filesColumn('costs'), { key: 'notes', label: 'Notes', type: 'longtext' },
    ],
    rows: () => { const n = attachmentCounts('costs'); return app.ds.costs.map((c) => ({ _rec: c, files: n.get(c.CostID) || 0, original: fxText(c), date: c.StartDate, end: c.EndDate, projectId: c.ProjectID, clientId: clientIdOf(c.ProjectID), project: projectLabel(app.idx, c.ProjectID), item: c.CostItem, amount: Dec.from(c.CostAmount), notes: withRepeats(c.CostNotes, repeatsLabel(c)) })); },
    totals: (rows) => ({ date: 'Total', amount: sum(rows, 'amount') }),
    // Totals of the costs matching the filters; commission lines follow the same filters.
    kpis: (rows, all, { derived = [] } = {}) => {
      const recorded = sum(rows, 'amount'), comm = sum(derived, 'amount');
      // Run rate: costs + commission dated in the last 180 days (today included; future-dated entries left out).
      const today = todayISO(), since = addDays(today, -179);
      const recent = sum([...rows, ...derived].filter((r) => r.date >= since && r.date <= today), 'amount');
      const perDay = recent.div(180, 10), perMonth = perDay.mul('30.4375');
      return [
        { label: 'Total costs', value: fmtMoney(recorded.add(comm)), sub: 'Recorded costs + earned sales commission', icon: 'money', tone: 'teal' },
        { label: 'Cost per day', value: fmtMoney(perDay), sub: `Average of the last 180 days (${fmtMoney(recent)} since ${since})`, icon: 'calendar', tone: 'slate' },
        { label: 'Cost per month', value: fmtMoney(perMonth), sub: 'Cost per day × 30.44 (last 180 days)', icon: 'creditCard', tone: 'blue' },
        { label: 'Sales commission', value: fmtMoney(comm), sub: `${plural(derived.length, 'line')} earned`, icon: 'users', tone: 'amber' },
      ];
    },
    // Earned commission is already a cost (sales fees) in every result; listed here read-only so it is visible.
    derived: {
      title: 'Sales commission (earned)',
      note: 'Calculated from Employee Activities and Client Acquisitions and counted as costs in all profit figures. Edit the source record to change it. Sales Payouts only settle this — they are not added again.',
      empty: 'No sales commission matches the current filters.',
      rows: () => [
        ...app.ds.activities.map((a) => ({ a, e: activityEarning(app.idx, a).earned })).filter(({ e }) => !e.isZero()).map(({ a, e }) => ({
          _link: { store: 'activities', id: a.ActivityID, label: 'activity' }, date: a.ActivityDate, end: null, projectId: a.ProjectID, clientId: clientIdOf(a.ProjectID), spId: a.SalespersonID,
          project: projectLabel(app.idx, a.ProjectID), item: `Sales commission — ${salespersonName(app.idx, a.SalespersonID)} (${a.ActivityType})`, amount: e, notes: a.LeadNotes,
        })),
        ...acquisitionLines(app.idx).filter((l) => !l.commission.isZero()).map((l) => ({
          _link: { store: 'acquisitions', id: l.acquisition.AcquisitionID, label: 'acquisition' }, date: l.income.StartDate, end: null, projectId: l.project.ProjectID, clientId: l.project.ClientID, spId: l.acquisition.SalespersonID,
          project: projectLabel(app.idx, l.project.ProjectID), item: `Acquisition commission — ${salespersonName(app.idx, l.acquisition.SalespersonID)}`, amount: l.commission, notes: null,
        })),
      ],
      columns: () => [
        { key: 'date', label: 'Date', type: 'date' }, { key: 'project', label: 'Client / Project', type: 'text' },
        { key: 'item', label: 'Salesperson & Description', type: 'longtext' }, { key: 'amount', label: 'Cost Amount', type: 'money', strong: true },
      ],
      subtotal: (commRows) => h('span', {}, 'Subtotal: ', h('strong', {}, fmtMoney(sum(commRows, 'amount')))),
      summary: (costRows, commRows) => h('div', { class: 'grand-total' }, h('span', { class: 'grand-total-label' }, 'Total costs incl. sales commission:'), h('span', { class: 'grand-total-value' }, fmtMoney(sum(costRows, 'amount').add(sum(commRows, 'amount'))))),
    },
    defaults: () => ({ StartDate: todayISO() }),
    formFields: (ex) => [
      { name: 'ProjectID', label: 'Project / internal cost centre', type: 'select', required: true, wide: true, options: () => projectOptions(ex?.ProjectID) },
      splitField('SplitWith', ex
        ? 'Add projects to share this cost. Submit changes this record to an equal share and adds a cost record for each added project.'
        : 'Add projects to share this expense. Submit saves a separate cost record for each project with an equal share of the amount.'),
      { name: 'StartDate', label: 'Start date', type: 'date', required: true },
      { name: 'EndDate', label: 'End date (optional)', type: 'date', help: 'Descriptive only — the cost is not spread.' },
      { name: 'CostItem', label: 'Cost item / salary description', type: 'text', wide: true, help: 'May be left blank.' },
      ...fxFields(ex, { name: 'CostAmount', label: 'Amount', type: 'money', required: true, help: 'When splitting, enter the full amount — it is divided between the projects.' }),
      { name: 'CostNotes', label: 'Notes', type: 'textarea' },
    ],
    initial: fxInitial,
    onInit: (form) => fxSuffixes(form),
    onChange: (form, name) => { if (name === 'ProjectID') form.refreshOptions(); fxSuffixes(form); },
    prepare: (d, ex) => fxPrepare('costs', d, ex),
    validate: fxValidate,
    beforeSubmit: (d) => fxBeforeSubmit('costs', d),
    ...attachHooks('costs'),
    preview: (d) => h('div', {}, fxPreview('costs', d), isForeign(d) ? splitPreview(splitProjects(d), d.OriginalAmount, d.Currency) : splitPreview(splitProjects(d), d.CostAmount)),
    // A cost with extra projects becomes one record per project. When editing, the first replaces the edited record;
    // the added shares are plain costs (not linked to a recurring rule, so the rule's bookkeeping is unaffected).
    expand: (d, ex) => {
      const ids = splitProjects(d);
      if (ids.length < 2) return null;
      // In another currency the amount in that currency is split, and each share converted at the same rate.
      const fx = isForeign(d);
      const parts = splitEqually(fx ? d.OriginalAmount : d.CostAmount, ids.length);
      const note = `Split equally across ${ids.length} projects (total ${fx ? fmtForeign(d.Currency, d.OriginalAmount) : fmtMoney(d.CostAmount)}).`;
      const base = (d.CostNotes || '').replace(SPLIT_NOTE_RE, '').trim();
      return ids.map((pid, k) => ({ ...d, ProjectID: pid, ...(fx ? { OriginalAmount: parts[k].toMoney(), CostAmount: baseAmount(parts[k], d.FxRate) } : { CostAmount: parts[k].toMoney() }), CostNotes: base ? `${base}\n${note}` : note, RecurringID: k === 0 && ex ? d.RecurringID : null }));
    },
  },

  activities: {
    store: 'activities', title: 'Employee Activities', addLabel: 'Add activity', filters: ['client', 'project', 'salesperson', 'type:Close|Attended meeting', 'date'], dateLabel: 'activity date', wideForm: true,
    description: 'Closes and attended meetings. Close earns (base override ?? credited paid revenue) × (rate override ?? default rate); a meeting earns (fee override ?? default fee). Closes for clients with an acquisition record earn nothing here — their commission comes from the 180-day acquisition rule. Record payments in Sales Payouts.',
    describe: (r) => `${r.ActivityDate} ${r.ActivityType} ${projectLabel(app.idx, r.ProjectID)}`,
    columns: () => [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'project', label: 'Client / Project', type: 'text' }, { key: 'sp', label: 'Salesperson', type: 'text' },
      { key: 'type', label: 'Type', type: 'text' }, { key: 'notes', label: 'Lead Notes', type: 'longtext' }, { key: 'credited', label: 'Credited Revenue', type: 'money' },
      { key: 'earned', label: 'Earned', type: 'money' }, { key: 'legacy', label: 'Legacy Paid', type: 'money' },
    ],
    rows: () => app.ds.activities.map((a) => { const e = activityEarning(app.idx, a); return { _rec: a, date: a.ActivityDate, projectId: a.ProjectID, clientId: clientIdOf(a.ProjectID), spId: a.SalespersonID, project: projectLabel(app.idx, a.ProjectID), sp: salespersonName(app.idx, a.SalespersonID), type: a.ActivityType, notes: a.LeadNotes, credited: e.credited, earned: e.earned, legacy: a.CommissionPaid === null ? null : Dec.from(a.CommissionPaid) }; }),
    totals: (rows) => ({ date: 'Total', credited: sum(rows, 'credited'), earned: sum(rows, 'earned'), legacy: sum(rows, 'legacy') }),
    defaults: () => ({ ActivityDate: todayISO(), ActivityType: 'Close' }),
    formFields: (ex) => [
      { name: 'ActivityDate', label: 'Activity date', type: 'date', required: true },
      { name: 'ActivityType', label: 'Activity type', type: 'select', required: true, numeric: false, options: () => ACTIVITY_TYPES.map((t) => ({ value: t, label: t })) },
      { name: 'ProjectID', label: 'Project', type: 'select', required: true, wide: true, options: () => projectOptions(ex?.ProjectID) },
      { name: 'SalespersonID', label: 'Salesperson', type: 'select', required: true, options: () => salespersonOptions(ex?.SalespersonID) },
      { name: 'PaidAmountCredited', label: 'Credited paid revenue', type: 'money', help: 'Paid revenue this close is credited with.' },
      { name: 'BaseOverride', label: 'Commission base override (optional)', type: 'money', hidden: (v) => v.ActivityType !== 'Close', hiddenValue: undefined, help: 'Blank = use credited revenue. 0 = zero base.' },
      { name: 'CloseRateOverride', label: 'Close rate override (optional)', type: 'percent', hidden: (v) => v.ActivityType !== 'Close', hiddenValue: undefined, help: 'Blank = salesperson default. 0 = earns nothing.' },
      { name: 'MeetingFeeOverride', label: 'Meeting fee override (optional)', type: 'money', hidden: (v) => v.ActivityType !== 'Attended meeting', hiddenValue: undefined, help: 'Blank = salesperson default fee.' },
      { name: 'LeadNotes', label: 'Lead notes', type: 'textarea' },
      ...(ex && ex.CommissionPaid !== null ? [{ name: 'CommissionPaid', label: 'Legacy commission paid (imported field)', type: 'money', help: 'Kept from the old per-activity field. Record new payments in Sales Payouts instead.' }] : []),
    ],
    preview: (d) => {
      const idx = withDraft('activities', d, 'ActivityID');
      const act = { ...d, BaseOverride: d.BaseOverride ?? null, CloseRateOverride: d.CloseRateOverride ?? null, MeetingFeeOverride: d.MeetingFeeOverride ?? null, CommissionPaid: d.CommissionPaid ?? null };
      if (!act.SalespersonID || !act.ProjectID || !act.ActivityType) return preview('Calculated earning', pv('Earned', 'Choose a project, salesperson and type'));
      const e = activityEarning(idx, act);
      const sp = idx.salespeople.get(act.SalespersonID);
      const rows = [];
      if (act.ActivityType === 'Close') {
        if (e.suppressed) rows.push(h('p', { class: 'note note-info' }, 'This client has a client-acquisition record, so ordinary Close commission (and its credited revenue) is suppressed — commission comes from eligible project income within 180 days of acquisition.'));
        else rows.push(pv('Base', e.base === null ? '— (no credited revenue)' : fmtMoney(e.base) + (act.BaseOverride !== null ? ' (override)' : '')), pv('Rate', e.rate === null ? '—' : fmtRate(e.rate) + (act.CloseRateOverride !== null ? ' (override)' : ` (default ${fmtRate(sp?.CloseRate)})`)));
      } else rows.push(pv('Meeting fee', e.fee === null ? '—' : fmtMoney(e.fee) + (act.MeetingFeeOverride !== null ? ' (override)' : ' (default)')));
      rows.push(pv('Earned', fmtMoney(e.earned), 'pv-strong'));
      return preview('Calculated earning (not saved yet)', rows);
    },
  },

  payouts: {
    store: 'payouts', title: 'Sales Payouts', addLabel: 'Record payout', filters: ['salesperson', 'date'], dateLabel: 'payout date',
    description: 'Commission payments to salespeople (partial payments allowed). Payouts reduce the amount owed — they do not reduce profit again, because earned sales fees are already counted as costs.',
    describe: (r) => `${r.PayoutDate} ${salespersonName(app.idx, r.SalespersonID)} ${fmtMoney(r.AmountPaid)}`,
    columns: () => [
      { key: 'date', label: 'Payout Date', type: 'date' }, { key: 'sp', label: 'Salesperson', type: 'text' },
      { key: 'amount', label: 'Amount Paid', type: 'money' }, { key: 'notes', label: 'Reference / Notes', type: 'longtext' },
    ],
    rows: () => app.ds.payouts.map((p) => ({ _rec: p, date: p.PayoutDate, spId: p.SalespersonID, sp: salespersonName(app.idx, p.SalespersonID), amount: Dec.from(p.AmountPaid), notes: p.PayoutNotes })),
    totals: (rows) => ({ date: 'Total', amount: sum(rows, 'amount') }),
    defaults: () => ({ PayoutDate: todayISO() }),
    formFields: (ex) => [
      { name: 'SalespersonID', label: 'Salesperson', type: 'select', required: true, options: () => salespersonOptions(ex?.SalespersonID) },
      { name: 'PayoutDate', label: 'Payout date', type: 'date', required: true },
      { name: 'AmountPaid', label: 'Amount paid', type: 'money', required: true, help: 'Must be greater than zero.' },
      { name: 'PayoutNotes', label: 'Reference / notes', type: 'textarea' },
    ],
    preview: (d, ex) => {
      if (!d.SalespersonID) return preview('Balance', pv('Salesperson', 'Choose a salesperson to see their balance'));
      const bal = salespersonBalance(app.idx, d.SalespersonID);
      const already = ex && ex.SalespersonID === d.SalespersonID ? Dec.from(ex.AmountPaid) : Z();
      const paying = d.AmountPaid ? Dec.from(d.AmountPaid) : Z();
      const after = bal.owed.add(already).sub(paying);
      return preview('Balance for ' + salespersonName(app.idx, d.SalespersonID),
        pv('Total earned (all time)', fmtMoney(bal.earned)), pv('Paid out so far', fmtMoney(bal.paidOut.sub(already))),
        pv('Outstanding before this payout', fmtMoney(bal.owed.add(already)), bal.owed.add(already).sign() < 0 ? 'neg' : ''),
        pv('Outstanding after this payout', fmtMoney(after), `pv-strong ${after.sign() < 0 ? 'neg' : ''}`),
        after.sign() < 0 ? h('p', { class: 'note note-warning' }, 'This payout is more than the amount owed. The balance will show as a negative (advance/overpayment).') : null);
    },
    beforeSubmit: async (d, ex) => {
      const bal = salespersonBalance(app.idx, d.SalespersonID);
      const already = ex && ex.SalespersonID === d.SalespersonID ? Dec.from(ex.AmountPaid) : Z();
      const after = bal.owed.add(already).sub(d.AmountPaid);
      if (after.sign() >= 0) return true;
      return confirmDialog(`This payout of ${fmtMoney(d.AmountPaid)} is more than the ${fmtMoney(bal.owed.add(already))} currently owed. The salesperson will show an advance/overpayment of ${fmtMoney(after.neg())}.`, { title: 'Overpayment', ok: 'Record overpayment', cancel: 'Go back' });
    },
  },

  acquisitions: {
    store: 'acquisitions', title: 'Client Acquisitions', addLabel: 'Add acquisition', filters: ['client', 'salesperson', 'date'], dateLabel: 'acquisition date', wideForm: true,
    description: 'One record per acquired (non-internal) client. The salesperson earns the stored rate on every paid income of that client\'s client projects whose start date is on/after the acquisition date and before the exclusive stop date (acquisition date + 180 days) — including projects added later. Ordinary Close commission for that client is then suppressed.',
    describe: (r) => `${clientNameById(app.idx, r.ClientID)} (${r.AcquisitionDate})`,
    columns: () => [
      { key: 'client', label: 'Client', type: 'text' }, { key: 'sp', label: 'Salesperson', type: 'text' }, { key: 'date', label: 'Acquisition Date', type: 'date' },
      { key: 'stop', label: 'Exclusive Stop Date', type: 'date' }, { key: 'rate', label: 'Rate', type: 'rate' }, { key: 'income', label: 'Eligible Income', type: 'money' },
      { key: 'earned', label: 'Earned Commission', type: 'money' }, { key: 'status', label: 'Window', type: 'text' },
    ],
    rows: () => acquisitionSummaries(app.idx).map((s) => ({ _rec: s.acquisition, clientId: s.acquisition.ClientID, spId: s.acquisition.SalespersonID, client: clientNameById(app.idx, s.acquisition.ClientID), sp: salespersonName(app.idx, s.acquisition.SalespersonID), date: s.acquisition.AcquisitionDate, stop: s.windowEnd, rate: s.acquisition.AcquisitionRate, income: s.eligibleIncome, earned: s.earned, status: s.status })),
    totals: (rows) => ({ client: 'Total', rate: null, income: sum(rows, 'income'), earned: sum(rows, 'earned') }),
    defaults: () => ({ AcquisitionDate: todayISO() }),
    formFields: (ex) => [
      { name: 'ClientID', label: 'Client', type: 'select', required: true, options: () => clientOptions(ex?.ClientID, { nonInternal: true }).filter((o) => o.value === ex?.ClientID || !app.idx.acqByClient.has(o.value)), help: 'Internal clients and clients that already have an acquisition are not listed.' },
      { name: 'SalespersonID', label: 'Acquiring salesperson', type: 'select', required: true, options: () => salespersonOptions(ex?.SalespersonID), help: 'Choosing a salesperson fills in their current close rate; you can change it.' },
      { name: 'AcquisitionDate', label: 'Acquisition date', type: 'date', required: true },
      { name: 'AcquisitionRate', label: 'Acquisition commission rate', type: 'percent', required: true, help: 'Stored with this record; later changes to the salesperson default do not change it.' },
      { name: 'AcquisitionNotes', label: 'Notes', type: 'textarea' },
    ],
    onChange: (form, name) => {
      if (name !== 'SalespersonID') return;
      const sp = app.idx.salespeople.get(Number(form.controls.SalespersonID.input.value));
      if (sp) form.setValue('AcquisitionRate', sp.CloseRate ?? 0);
    },
    preview: (d) => {
      if (!d.ClientID || !d.AcquisitionDate || d.AcquisitionRate === null || d.AcquisitionRate === undefined || !d.SalespersonID) return preview('180-day window', pv('Window', 'Choose client, salesperson, date and rate'));
      const idx = withDraft('acquisitions', { ...d, AcquisitionNotes: d.AcquisitionNotes ?? null }, 'AcquisitionID');
      const lines = acquisitionLines(idx).filter((l) => l.acquisition.ClientID === d.ClientID);
      const stop = acquisitionWindowEnd(d.AcquisitionDate), today = todayISO();
      return preview('180-day window (preview, not saved yet)',
        pv('Exclusive stop date', `${stop} (income dated ${stop} or later is not eligible)`),
        pv('Window status', today < d.AcquisitionDate ? 'Not started' : today < stop ? 'Active' : 'Ended'),
        pv('Eligible income so far', `${fmtMoney(Dec.sum(lines.map((l) => l.revenue)))} (${lines.length} record${lines.length === 1 ? '' : 's'})`),
        pv('Earned commission so far', fmtMoney(Dec.sum(lines.map((l) => l.commission))), 'pv-strong'));
    },
  },
};

// Income per day: income dated in the last 180 days (today included; future-dated payments left out) ÷ 180, as Cost per day on Project Costs.
function incomePerDay(rows) {
  const today = todayISO(), since = addDays(today, -179);
  const recent = sum(rows.filter((r) => r.date >= since && r.date <= today), 'amount');
  return { label: 'Income per day', value: fmtMoney(recent.div(180, 10)), sub: `Average of the last 180 days (${fmtMoney(recent)} since ${since})`, icon: 'calendar', tone: 'green' };
}

// ---------- contracts / clauses list helpers ----------
// Client status: Archived; the internal client is always Active; otherwise from its contracts — Active with an active
// contract, Upcoming when the only live contracts have not started yet, Inactive with none (or all ended).
function clientStatus(c) {
  if (c.Archived) return 'Archived';
  if (c.IsInternal) return 'Active';
  const today = todayISO(), st = app.ds.contracts.filter((k) => k.ClientID === c.ClientID).map((k) => contractStatus(k, app.ds.clauses, today));
  return st.includes('Active') ? 'Active' : st.includes('Upcoming') ? 'Upcoming' : 'Inactive';
}
const CLIENT_STATUS_TONE = { Active: 'pos', Upcoming: 'brand', Inactive: 'warn', Archived: 'neutral' };
// Project status: Archived / hidden because its contracts ended; internal cost centres are always Active; a client
// project is Active with an active contract, Upcoming when its contract has not started, otherwise No active contract.
function projectStatus(p, why, contractStatuses) {
  if (why === 'archived') return 'Archived';
  if (why === 'contract ended') return 'Hidden · contract ended';
  if (p.ProjectType !== 'Client') return 'Active';
  return contractStatuses.includes('Active') ? 'Active' : contractStatuses.includes('Upcoming') ? 'Upcoming' : 'No active contract';
}
const PROJECT_STATUS_TONE = { Active: 'pos', Upcoming: 'brand', 'No active contract': 'warn' };
const STATUS_TONE = { Active: 'pos', Upcoming: 'brand', Ended: 'neutral', 'No clauses': 'neutral' };
// Status pill plus the renewal note underneath (amber within a month, red within a week / overdue).
function statusCell(r) {
  if (!r._rec) return '';
  return h('span', {}, pill(r.statusKey, STATUS_TONE[r.statusKey] || 'neutral', true),
    r.urgency ? h('span', { class: `cell-note ${r.urgency.level === 'urgent' ? 'urgent' : 'warn'}` }, r.urgency.note) : null);
}
// Renewal and duration summary cards for the listed clauses, counted per contract: contracts whose renewal approval is
// due within a month (or overdue), contracts with a renewal date in the next 3 months, and the average contract length.
function renewalKpis(rows) {
  const today = todayISO(), in3 = addMonthsClamped(today, 3);
  const byContract = new Map();
  for (const r of rows) if (r._rec) { if (!byContract.has(r.contractId)) byContract.set(r.contractId, []); byContract.get(r.contractId).push(r._rec); }
  let dueSoon = 0, due3 = 0;
  const lengths = [];
  for (const [cid, ks] of byContract) {
    if (rows.some((r) => r.contractId === cid && r.urgency)) dueSoon++;
    // Renewal date = approval-needed-by date, or the end date when no notice period is set; active clauses only.
    if (ks.some((k) => { if (clauseStatus(k, today) !== 'Active') return false; const d = renewalDecisionDate(k) ?? clauseEndDate(k); return d && d <= in3; })) due3++;
    // Contract length = earliest clause start to latest clause end; skipped when any clause runs until cancelled.
    const ends = ks.map(clauseEndDate);
    if (ends.every(Boolean)) {
      const start = ks.map((k) => k.StartDate).sort()[0], end = ends.sort().at(-1);
      lengths.push(Math.max(0, (Date.parse(end) - Date.parse(start)) / 86400000 / 30.4375));
    }
  }
  const avg = lengths.length ? lengths.reduce((a, b) => a + b, 0) / lengths.length : null;
  const avgValue = avg === null ? '—' : avg >= 12 ? String(+(avg / 12).toFixed(1)) : String(Math.round(avg));
  const avgUnit = avg === null ? null : avg >= 12 ? (+(avg / 12).toFixed(1) === 1 ? 'year' : 'years') : (Math.round(avg) === 1 ? 'month' : 'months');
  return [
    { label: 'Up for renewal', value: dueSoon, unit: dueSoon === 1 ? 'contract' : 'contracts', sub: 'Approval due within a month or overdue', subTone: dueSoon ? 'neg' : null, icon: 'bell', tone: dueSoon ? 'rose' : 'slate' },
    { label: 'Renewal in 3 months', value: due3, unit: due3 === 1 ? 'contract' : 'contracts', sub: `Renewal date on or before ${in3}`, icon: 'calendar', tone: 'amber' },
    { label: 'Average contract duration', value: avgValue, unit: avgUnit, sub: lengths.length ? `Across ${plural(lengths.length, 'fixed-term contract')}` : 'No fixed-term contracts listed', icon: 'clock', tone: 'teal' },
  ];
}
// Charged / cost / margin summary cards for rows with charge, cost and margin (Dec or null).
function moneyKpis(rows, chargeLabel, chargeSub, costLabel = 'Cost to Engineered Plans', costSub = 'Hosting, domains and other vendor costs', marginSub = 'Charged to client minus cost') {
  const charge = sum(rows, 'charge'), cost = sum(rows, 'cost'), margin = sum(rows, 'margin');
  const pct = charge.isZero() ? null : margin.div(charge, 10), neg = margin.round(2).sign() < 0;
  return [
    { label: chargeLabel, value: fmtMoney(charge), sub: chargeSub, icon: 'money', tone: 'teal' },
    { label: costLabel, value: fmtMoney(cost), sub: costSub, icon: 'receipt', tone: 'amber' },
    { label: 'Margin', value: fmtMoney(margin), valueTone: neg ? 'neg' : 'pos', pill: pct === null || neg ? null : fmtMargin(pct), sub: neg ? `${pct === null ? '' : fmtMargin(pct) + ' · '}costs exceed income` : marginSub, subTone: neg ? 'neg' : null, icon: 'trend', tone: neg ? 'slate' : 'green' },
  ];
}
