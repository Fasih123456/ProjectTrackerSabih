// Currencies: the enabled foreign currencies (base CAD) with their latest mid-market rate, the entries still waiting
// for the rate of their own date, a rate lookup for any day, and a manual refresh of the background job.
import { h, replace, toast, icon, confirmDialog } from '../dom.js';
import { app } from '../state.js';
import { statCard } from '../crud.js';
import { dataTable } from '../table.js';
import { todayISO, addDays } from '../../lib/dates.js';
import { fmtDateTime } from '../../lib/format.js';
import { BASE, BASE_SYMBOL, BASE_LABEL, isForeign, rateFrom, latestRate, getLatestDay, fmtForeign, fmtRateValue } from '../../calc/fx.js';
import { enabledCurrencies, setEnabledCurrencies, currencyNames, getDay, pendingFx, isNotPublished, SOURCE_LABEL } from '../../io/fxRates.js';
import { projectLabel } from '../../calc/calc.js';

const lookup = { date: null }; // rate lookup date, kept while the page is redrawn

// Records and rules using a currency.
function usage(code) {
  const n = (rows) => rows.filter((r) => r.Currency === code).length;
  return { income: n(app.ds.income), costs: n(app.ds.costs), rules: n(app.ds.recurring) };
}

export function renderCurrencies(container) {
  const codes = enabledCurrencies();
  const latest = getLatestDay();
  const today = todayISO();
  const last = app.fxLast;
  const redraw = () => renderCurrencies(container);

  const refreshBtn = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
    refreshBtn.disabled = true; refreshBtn.textContent = 'Checking…';
    try {
      const r = await app.runFx();
      if (r.error && !r.refreshed) toast(`Rates could not be refreshed: ${r.error}`, 'error', 8000);
      else if (!r.finalized) toast(`Rates are up to date (${getLatestDay()?.date ?? 'no rates yet'}).${r.pending ? ` ${r.pending} entr${r.pending === 1 ? 'y is' : 'ies are'} still waiting for the rate of ${r.pending === 1 ? 'its' : 'their'} date.` : ''}`, 'ok', 6000);
    } finally { if (container.isConnected) redraw(); }
  } }, icon.sync(), ' Refresh rates now');

  // One card per currency: latest rate and the change over 30 days (filled in once that day is loaded).
  const cards = codes.map((c) => {
    const lr = latestRate(c);
    const k = { label: `${c} → ${BASE_LABEL}`, value: lr ? fmtRateValue(lr.rate) : '—', unit: BASE_SYMBOL, sub: lr ? `1 ${c} on ${lr.date}` : 'No rate downloaded yet', icon: 'money', tone: 'teal' };
    const el = statCard(k);
    if (lr) {
      getDay(addDays(lr.date, -30)).then((d) => {
        const old = rateFrom(d, c);
        if (old === null) return;
        const pct = ((lr.rate - old) / old) * 100;
        const sub = el.querySelector('.stat-sub');
        if (sub) { sub.textContent = `1 ${c} on ${lr.date} · ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}% in 30 days`; sub.classList.add(pct >= 0 ? 'pos' : 'neg'); }
      }).catch(() => {});
    }
    return el;
  });

  // Enabled currencies table with usage; a currency in use cannot be removed.
  const rows = codes.map((c) => { const u = usage(c); return { code: c, name: '', rate: latestRate(c)?.rate ?? null, income: u.income, costs: u.costs, rules: u.rules, used: u.income + u.costs + u.rules }; });
  const table = dataTable({
    columns: [
      { key: 'code', label: 'Currency', type: 'text', strong: true }, { key: 'name', label: 'Name', type: 'text' },
      { key: 'rate', label: `${BASE_SYMBOL} per 1 (latest)`, type: 'text', align: 'right', render: (r) => fmtRateValue(r.rate) },
      { key: 'income', label: 'Income entries', type: 'int' }, { key: 'costs', label: 'Cost entries', type: 'int' }, { key: 'rules', label: 'Recurring rules', type: 'int' },
    ],
    rows, noSort: true, caption: 'Enabled currencies', empty: `Only ${BASE_LABEL} is enabled. Add a currency below.`, idOf: () => null,
    actions: (r) => [h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', disabled: r.used > 0, title: r.used ? 'In use: entries or rules use this currency' : `Remove ${r.code}`,
      onclick: async () => {
        if (!(await confirmDialog(`Remove ${r.code} from the currency list? You can add it again at any time.`, { title: 'Remove currency?', ok: 'Remove' }))) return;
        await setEnabledCurrencies(codes.filter((x) => x !== r.code)); await app.reload(); redraw();
      } }, icon.trash(), ' Remove')],
  });
  currencyNames().then((names) => {
    for (const tr of table.querySelectorAll('tbody tr')) {
      const code = tr.cells[0]?.textContent.trim();
      if (code && names[code.toLowerCase()] && tr.cells[1]) tr.cells[1].textContent = names[code.toLowerCase()];
    }
  });

  // Add a currency: any code the rate source publishes.
  const addSel = h('select', { 'aria-label': 'Currency to add' }, h('option', { value: '' }, 'Loading currencies…'));
  currencyNames().then((names) => {
    const opts = Object.entries(names).map(([k, v]) => [k.toUpperCase(), v]).filter(([k]) => /^[A-Z]{3}$/.test(k) && k !== BASE && !codes.includes(k) && (!latest || rateFrom(latest, k) !== null)).sort();
    replace(addSel, h('option', { value: '' }, opts.length ? 'Choose a currency…' : Object.keys(names).length ? 'No other currencies have rates' : 'Currency list unavailable (offline?)'), opts.map(([k, v]) => h('option', { value: k }, `${k} — ${v || k}`)));
  });
  const addBtn = h('button', { type: 'button', class: 'btn', onclick: async () => {
    if (!addSel.value) { toast('Choose a currency to add.', 'error'); return; }
    await setEnabledCurrencies([...codes, addSel.value]); await app.reload(); toast(`${addSel.value} added.`); redraw();
  } }, icon.plus(), ' Add currency');

  // Entries whose rate is provisional (future-dated, or their day is not published yet).
  const pend = pendingFx().sort((a, b) => a.rec.StartDate.localeCompare(b.rec.StartDate));
  const pendTable = dataTable({
    columns: [
      { key: 'date', label: 'Date', type: 'date' }, { key: 'kind', label: 'Type', type: 'text' }, { key: 'project', label: 'Client / Project', type: 'text' },
      { key: 'orig', label: 'Amount', type: 'text' }, { key: 'rate', label: 'Rate used for now', type: 'text' }, { key: 'base', label: `${BASE_SYMBOL} for now`, type: 'money' },
      { key: 'when', label: 'Final rate', type: 'text' },
    ],
    rows: pend.map(({ store, rec, due }) => ({ _rec: rec, store, date: rec.StartDate, kind: store === 'income' ? 'Income' : 'Cost', project: projectLabel(app.idx, rec.ProjectID),
      orig: fmtForeign(rec.Currency, rec.OriginalAmount), rate: `${fmtRateValue(rec.FxRate)} (${rec.FxDate})`, base: store === 'income' ? rec.AmountPaid : rec.CostAmount,
      when: due ? 'Applied as soon as that day is published' : `From ${rec.StartDate}` })),
    noSort: true, caption: 'Waiting for the final rate', empty: 'Nothing is waiting: every entry in another currency uses the rate of its own date (or the actual rate you entered).',
    idOf: (r) => r._rec[r.store === 'income' ? 'IncomeID' : 'CostID'],
    onOpen: (r) => { location.hash = `#/${r.store}?edit=${r._rec[r.store === 'income' ? 'IncomeID' : 'CostID']}`; },
  });

  // Rate lookup for any day (cached once downloaded).
  lookup.date ||= latest?.date || today;
  const lookupOut = h('div', { class: 'fx-lookup-out' });
  const showLookup = async () => {
    replace(lookupOut, h('p', { class: 'muted' }, 'Looking up…'));
    try {
      const day = await getDay(lookup.date);
      replace(lookupOut, h('table', { class: 'fx-lookup-table' }, h('tbody', {},
        (codes.length ? codes : ['USD']).map((c) => h('tr', {}, h('th', { scope: 'row' }, `1 ${c}`), h('td', { class: 'num' }, `${fmtRateValue(rateFrom(day, c))} ${BASE_LABEL}`))))),
      h('p', { class: 'muted small' }, `Mid-market rates of ${day.date}.`));
    } catch (e) {
      replace(lookupOut, h('p', { class: 'muted' }, isNotPublished(e) ? `No rates are published for ${lookup.date} (${lookup.date > today ? 'a future date' : lookup.date >= addDays(today, -1) ? 'not published yet' : 'before the source’s history, which starts in March 2024'}).` : e.message));
    }
  };
  const dateIn = h('input', { type: 'date', value: lookup.date, max: today, 'aria-label': 'Date to look up', onchange: () => { if (dateIn.value) { lookup.date = dateIn.value; showLookup(); } } });
  showLookup();

  const used = [...app.ds.income, ...app.ds.costs].filter(isForeign);
  replace(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'title-row' }, h('h1', {}, 'Currencies'), h('span', { class: 'title-badge' }, `Primary currency: ${BASE_LABEL}`)),
        h('p', { class: 'lead' }, `The primary currency is ${BASE_LABEL}: every ${BASE_SYMBOL} amount, total and report is in ${BASE_LABEL}. Income and costs can also be entered in the currencies below; each entry is converted to ${BASE_LABEL} at the mid-market rate of its own date. Entries dated in the future use the latest rate until their own date’s rate is published, then they are updated automatically.`)),
      h('div', { class: 'page-actions' }, refreshBtn)),
    h('section', { class: 'stat-cards', 'aria-label': 'Latest rates' }, cards.length ? cards : statCard({ label: 'Currencies', value: `${BASE_LABEL} only`, sub: 'Add a currency below', icon: 'money', tone: 'slate' })),
    h('section', { class: 'card' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Enabled currencies'), h('span', { class: 'section-count' }, `${codes.length} + ${BASE_LABEL}`)),
      table,
      h('div', { class: 'fx-add' }, h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Add a currency'), addSel), addBtn)),
    h('section', { class: 'card' },
      h('div', { class: 'section-head' }, h('h2', {}, 'Waiting for the final rate'), h('span', { class: 'section-count' }, `${pend.length} entr${pend.length === 1 ? 'y' : 'ies'}`)),
      h('p', { class: 'muted small' }, 'Checked when the tracker opens and every hour while it is open. Double-click a row to open the entry.'),
      pendTable),
    h('section', { class: 'card' },
      h('h2', {}, 'Look up a rate'),
      h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, 'Date'), dateIn),
      lookupOut),
    h('section', { class: 'card' },
      h('h2', {}, 'Source and status'),
      h('dl', { class: 'fx-status' },
        h('div', {}, h('dt', {}, 'Rate source'), h('dd', {}, SOURCE_LABEL, ' — free, no account needed; one set of rates per day, history from March 2024.')),
        h('div', {}, h('dt', {}, 'Latest rates'), h('dd', {}, latest ? latest.date : 'Not downloaded yet')),
        h('div', {}, h('dt', {}, 'Last check'), h('dd', {}, last ? `${fmtDateTime(last.at)}${last.error && !last.refreshed ? ` — failed: ${last.error}` : ''}` : 'Not yet in this session')),
        h('div', {}, h('dt', {}, 'Entries in other currencies'), h('dd', {}, `${used.length} (${used.filter((r) => r.FxStatus === 'manual').length} with the actual rate received)`)))));
}
