// Dashboard: headline figures, monthly trend and client project results (tables are authoritative; the chart is supplementary).
import { h, replace, icon } from '../dom.js';
import { app } from '../state.js';
import { Dec } from '../../lib/decimal.js';
import { todayISO, firstOfMonth, lastOfMonth, addDays, monthLabel } from '../../lib/dates.js';
import { fmtMoney, fmtHours, fmtMargin } from '../../lib/format.js';
import { toCSV } from '../../io/csv.js';
import { downloadText, stampForFile } from '../../io/download.js';
import { companyTotals, salesSummary, projectRows, totalRow, monthlyCompany, monthlyRecurringRevenue, quarterToDateComparison } from '../../calc/calc.js';

const scopeState = { scope: 'all', from: null, to: null };
const viewState = { trend: 'monthly', page: 0 }; // trend: 'monthly' | 'cumulative'
const PAGE_SIZE = 8;

function scopeRange() {
  const t = todayISO();
  switch (scopeState.scope) {
    case 'month': return { from: firstOfMonth(t), to: lastOfMonth(t), label: `This month (${monthLabel(t.slice(0, 7))})` };
    case 'last': { const d = addDays(firstOfMonth(t), -1); return { from: firstOfMonth(d), to: lastOfMonth(d), label: `Last month (${monthLabel(d.slice(0, 7))})` }; }
    case 'year': return { from: t.slice(0, 4) + '-01-01', to: t.slice(0, 4) + '-12-31', label: `This year (${t.slice(0, 4)})` };
    case 'custom': return { from: scopeState.from, to: scopeState.to, label: `${scopeState.from || 'start'} to ${scopeState.to || 'end'}` };
    default: return { from: null, to: null, label: 'All time (every record, including future-dated)' };
  }
}

const sign = (d) => d.round(2).sign();
// Ratio change as a signed percentage: 0.5 -> "+50.0%", -0.25 -> "−25.0%".
const fmtChange = (d) => { const p = d.mul(100).round(1); return `${p.sign() > 0 ? '+' : p.sign() < 0 ? '−' : ''}${p.abs().toFixed(1)}%`; };
const fmtSignedMoney = (d) => { const s = sign(d); return `${s > 0 ? '+' : s < 0 ? '−' : ''}${fmtMoney(d.abs())}`; };

// ---------- KPI cards ----------
// accent: the 3px lead bar colour (primary | secondary | tertiary | primary-container | outline | amber).
function kpi(label, value, { accent = 'primary', sub = null, tone = null, foot = null } = {}) {
  return h('div', { class: `dash-kpi dash-accent-${accent}` },
    h('div', { class: 'dash-kpi-label' }, label),
    h('div', { class: `dash-kpi-value${tone ? ' ' + tone : ''}` }, value),
    sub ? h('div', { class: 'dash-kpi-sub' }, sub) : null,
    foot ? h('div', { class: 'dash-kpi-foot' }, foot) : null);
}
const toneOf = (d) => (sign(d) < 0 ? 'neg' : null);
function marginBadge(m, result) {
  if (m === null) return sign(result) < 0 ? h('span', { class: 'dash-badge dash-badge-neg' }, 'Deficit') : h('span', { class: 'muted' }, '—');
  return h('span', { class: `dash-badge ${sign(m) < 0 ? 'dash-badge-neg' : 'dash-badge-pos'}` }, fmtMargin(m));
}

// ---------- monthly trend chart ----------
// Income and expenses per month plus the running net total (or, in "Cumulative", running totals of all three), on one
// y-axis that includes zero. A callout marks the current month; hover or arrow keys show a crosshair tooltip.
const SERIES = [
  { key: 'paid', name: 'Income', cls: 'ln-income' },
  { key: 'actualCosts', name: 'Expenses', cls: 'ln-cost' },
  { key: 'cumulative', name: 'Net total', cls: 'ln-net' },
];

function niceTicks(min, max, count = 5) {
  if (min === max) { max = min + 1; }
  const raw = (max - min) / count, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  const lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}
const short = (v) => { const a = Math.abs(v), s = v < 0 ? '−' : ''; return a >= 1e6 ? `${s}${+(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${s}${+(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}k` : `${s}${Math.round(a)}`; };

function trendChart(months, mode) {
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };
  const plot = h('div', { class: 'chart-plot dash-plot', tabindex: '0', role: 'img', 'aria-label': `${mode === 'cumulative' ? 'Cumulative' : 'Monthly'} income and expenses with running net total line chart. Use left and right arrow keys to read each month; the table below lists the same figures.` });
  const tip = h('div', { class: 'dash-tip', hidden: true });
  // Cumulative mode: running income and expenses too (the net total is always running).
  let ri = Dec.zero(), re = Dec.zero();
  const shown = months.map((m) => (mode === 'cumulative' ? { ...m, paid: (ri = ri.add(m.paid)), actualCosts: (re = re.add(m.actualCosts)) } : m));
  const vals = shown.map((m) => Object.fromEntries(SERIES.map((s) => [s.key, m[s.key].toNumber()])));
  const thisMonth = todayISO().slice(0, 7);
  const pinned = Math.max(0, (() => { const i = shown.findIndex((m) => m.month === thisMonth); return i >= 0 ? i : shown.length - 1; })());
  let active = -1, geom = null;

  const draw = () => {
    const W = Math.max(320, plot.clientWidth || 600), H = 260, L = 52, R = 16, T = 18, B = 30;
    const all = vals.flatMap((v) => SERIES.map((s) => v[s.key]));
    const ticks = niceTicks(Math.min(0, ...all), Math.max(0, ...all));
    const lo = ticks[0], hi = ticks[ticks.length - 1];
    const x = (i) => (shown.length === 1 ? L + (W - L - R) / 2 : L + 12 + (i * (W - L - R - 24)) / (shown.length - 1));
    const y = (v) => T + (H - T - B) * (1 - (v - lo) / (hi - lo));
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    const defs = el('defs', {});
    const grad = el('linearGradient', { id: 'dash-income-fill', x1: 0, x2: 0, y1: 0, y2: 1 });
    grad.append(el('stop', { offset: '0%', 'stop-color': '#00685f', 'stop-opacity': '0.18' }), el('stop', { offset: '100%', 'stop-color': '#00685f', 'stop-opacity': '0' }));
    defs.append(grad); svg.append(defs);
    for (const t of ticks) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'grid' }));
      svg.append(el('text', { x: L - 10, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' }, short(t)));
    }
    // Month labels: thin out to fit, keep the last month; the current month is bold.
    const n = shown.length;
    const every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor((W - L - R) / 76))));
    shown.forEach((m, i) => {
      const last = i === n - 1;
      if (!(i % every === 0 || last) || (!last && n - 1 - i < every && n > 1)) return;
      svg.append(el('text', { x: x(i), y: H - 8, class: `axis${m.month === thisMonth ? ' axis-current' : ''}`, 'text-anchor': 'middle' }, monthLabel(m.month)));
    });
    // Income area (down to the zero line), then the lines: net (dashed), expenses, income on top.
    const pts = (k) => vals.map((v, i) => `${x(i)},${y(v[k])}`);
    if (n > 1) svg.append(el('polygon', { points: [`${x(0)},${y(0)}`, ...pts('paid'), `${x(n - 1)},${y(0)}`].join(' '), fill: 'url(#dash-income-fill)' }));
    const cross = el('line', { y1: T, y2: H - B, class: 'crosshair', visibility: 'hidden' });
    svg.append(cross);
    const dots = [];
    for (const s of [SERIES[2], SERIES[1], SERIES[0]]) {
      svg.append(el('polyline', { points: pts(s.key).join(' '), class: `ln ${s.cls}` }));
      dots.push(vals.map((v, i) => { const c = el('circle', { cx: x(i), cy: y(v[s.key]), r: 0, class: `dot ${s.cls}` }); svg.append(c); return c; }));
    }
    // Marker dots on the pinned (current) month.
    const pinDots = SERIES.map((s) => el('circle', { cx: x(pinned), cy: y(vals[pinned][s.key]), r: s.key === 'cumulative' ? 3.5 : 4.5, class: `dot ${s.cls}` }));
    svg.append(...pinDots);
    replace(plot, svg, tip);
    geom = { x, y, W, cross, dots, pinDots };
    if (active >= 0) show(active); else showPinned();
  };

  // Default callout: the current month (or the latest month shown), with that month's net.
  function showPinned() {
    if (!geom || !shown.length) return;
    const m = shown[pinned];
    const net = mode === 'cumulative' ? m.cumulative : m.result;
    replace(tip, h('div', { class: 'dash-tip-title' }, monthLabel(m.month)),
      h('div', { class: `dash-tip-net${sign(net) < 0 ? ' neg' : ''}` }, `${mode === 'cumulative' ? 'Net total' : 'Net'}: ${fmtMoney(net)}`));
    tip.classList.add('dash-tip-pinned');
    place(geom.x(pinned), geom.y(vals[pinned].paid));
  }
  function place(px, py) {
    tip.hidden = false;
    const tw = tip.offsetWidth || 160, th = tip.offsetHeight || 44;
    tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), geom.W - tw)}px`;
    tip.style.top = `${Math.max(0, py - th - 14)}px`;
  }
  function show(i) {
    if (!geom || i < 0) return;
    active = i;
    const px = geom.x(i);
    geom.cross.setAttribute('x1', px); geom.cross.setAttribute('x2', px); geom.cross.setAttribute('visibility', 'visible');
    geom.dots.forEach((row) => row.forEach((c, j) => c.setAttribute('r', j === i ? 5 : 0)));
    geom.pinDots.forEach((c) => c.setAttribute('visibility', 'hidden'));
    const m = shown[i];
    tip.classList.remove('dash-tip-pinned');
    replace(tip, h('div', { class: 'dash-tip-title' }, monthLabel(m.month)),
      SERIES.map((s) => h('div', { class: 'dash-tip-row' }, h('span', { class: `lg ${s.cls}` }, s.name), h('span', { class: `dash-tip-val${sign(m[s.key]) < 0 ? ' neg' : ''}` }, fmtMoney(m[s.key])))));
    tip.hidden = false;
    const tw = tip.offsetWidth || 200;
    tip.style.top = '6px';
    tip.style.left = `${Math.min(Math.max(px + 14 + tw > geom.W ? px - tw - 14 : px + 14, 0), geom.W - tw)}px`;
  }
  function hide() {
    active = -1;
    if (!geom) return;
    geom.cross.setAttribute('visibility', 'hidden');
    geom.dots.forEach((row) => row.forEach((c) => c.setAttribute('r', 0)));
    geom.pinDots.forEach((c) => c.setAttribute('visibility', 'visible'));
    showPinned();
  }
  const nearest = (clientX) => {
    const px = clientX - plot.getBoundingClientRect().left;
    let best = 0;
    shown.forEach((_, i) => { if (Math.abs(geom.x(i) - px) < Math.abs(geom.x(best) - px)) best = i; });
    return best;
  };
  plot.addEventListener('pointermove', (e) => geom && show(nearest(e.clientX)));
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); show(active < 0 ? (e.key === 'ArrowRight' ? 0 : shown.length - 1) : Math.min(shown.length - 1, Math.max(0, active + (e.key === 'ArrowRight' ? 1 : -1)))); }
    else if (e.key === 'Escape') hide();
  });
  new ResizeObserver(() => draw()).observe(plot);
  requestAnimationFrame(draw);
  return plot;
}

// ---------- tables ----------
// Money cell: right-aligned tabular figure; negatives red in parentheses, zero muted, `signed` colours positives green.
function money(d, { signed = false, strong = false } = {}) {
  const s = d === null || d === undefined ? 0 : sign(d);
  const cls = ['num', s < 0 ? 'neg' : signed && s > 0 ? 'pos' : '', s === 0 && !strong ? 'zero' : '', strong ? 'strong' : ''];
  return h('td', { class: cls.filter(Boolean).join(' ') }, fmtMoney(d));
}
const th = (label, num = false) => h('th', { scope: 'col', class: num ? 'num' : null }, label);

function ledger(months) {
  const thisMonth = todayISO().slice(0, 7);
  const rows = [...months].reverse(); // newest first
  return h('div', { class: 'dash-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Monthly trend figures' },
    h('table', { class: 'dash-table' },
      h('caption', { class: 'sr-only' }, 'Monthly trend: income, expenses, net for the month and running net total'),
      h('thead', {}, h('tr', {}, th('Month'), th('Income', true), th('Expenses', true), th('Net', true), th('Net total', true))),
      h('tbody', {}, rows.map((m) => {
        const cur = m.month === thisMonth;
        return h('tr', { class: cur ? 'dash-row-current' : null, 'aria-current': cur ? 'date' : null },
          h('td', { class: 'dash-month' }, cur ? h('span', { class: 'dash-dot dash-dot-primary', 'aria-hidden': 'true' }) : null, monthLabel(m.month), cur ? h('span', { class: 'sr-only' }, ' (this month)') : null),
          money(m.paid), money(m.actualCosts), money(m.result, { signed: true, strong: true }), money(m.cumulative, { signed: true }));
      }))));
}

function projectTable(rows, tot, rerender) {
  const pages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
  viewState.page = Math.min(viewState.page, pages - 1);
  const start = viewState.page * PAGE_SIZE, page = rows.slice(start, start + PAGE_SIZE);
  const go = (p) => { viewState.page = p; rerender(); };
  const body = page.length
    ? page.map((r) => {
      const netProfit = r.paid.sub(r.costs); // paid income − recorded costs (before sales fees)
      const deficit = sign(r.actualResult) < 0;
      return h('tr', { class: deficit && r.paid.isZero() ? 'dash-row-deficit' : null },
        h('td', { class: 'dash-client' }, h('span', { class: `dash-dot ${deficit ? 'dash-dot-neg' : 'dash-dot-pos'}`, 'aria-hidden': 'true' }), r.clientName),
        h('td', { class: 'muted' }, r.projectName),
        money(r.paid), money(r.costs), money(netProfit, { signed: true, strong: true }), money(r.salesFees), money(r.actualResult, { signed: true }),
        h('td', { class: 'center' }, marginBadge(r.margin, r.actualResult)));
    })
    : [h('tr', {}, h('td', { class: 'empty', colspan: '8' }, 'No client project activity in this scope.'))];
  return h('div', { class: 'dash-table-frame' },
    h('div', { class: 'dash-table-wrap', tabindex: '0', role: 'region', 'aria-label': 'Client project results' },
      h('table', { class: 'dash-table' },
        h('caption', { class: 'sr-only' }, 'Client project results'),
        h('thead', {}, h('tr', {}, th('Client name'), th('Scope of work'), th('Paid income', true), th('Recorded costs', true), th('Net profit', true), th('Sales fee', true), th('Margin / net balance', true), h('th', { scope: 'col', class: 'center' }, 'Margin %'))),
        h('tbody', {}, body),
        rows.length ? h('tfoot', {}, h('tr', {},
          h('td', { colspan: '2' }, `Total (${rows.length} project${rows.length === 1 ? '' : 's'})`),
          money(tot.paid, { strong: true }), money(tot.costs, { strong: true }), money(tot.paid.sub(tot.costs), { signed: true, strong: true }), money(tot.salesFees, { strong: true }), money(tot.actualResult, { signed: true, strong: true }),
          h('td', { class: 'center' }, marginBadge(tot.margin, tot.actualResult)))) : null)),
    h('div', { class: 'dash-pager' },
      h('span', {}, rows.length ? `Showing ${start + 1}–${start + page.length} of ${rows.length} client project${rows.length === 1 ? '' : 's'} in this view` : 'No projects in this view'),
      pages > 1 ? h('div', { class: 'dash-pager-ctl' },
        h('button', { type: 'button', class: 'btn btn-small', disabled: viewState.page === 0, onclick: () => go(viewState.page - 1) }, 'Previous'),
        h('span', { class: 'dash-pager-num', 'aria-live': 'polite' }, `${viewState.page + 1} / ${pages}`),
        h('button', { type: 'button', class: 'btn btn-small', disabled: viewState.page >= pages - 1, onclick: () => go(viewState.page + 1) }, 'Next')) : null));
}

function fillMonths(list) {
  if (list.length < 2) return list;
  const by = new Map(list.map((m) => [m.month, m]));
  const out = [];
  let [y, mo] = list[0].month.split('-').map(Number);
  const last = list[list.length - 1].month;
  for (let ym = list[0].month; ym <= last; ym = `${y}-${String(mo).padStart(2, '0')}`) {
    out.push(by.get(ym) || { month: ym, paid: Dec.zero(), actualCosts: Dec.zero(), result: Dec.zero() });
    if (++mo > 12) { mo = 1; y++; }
  }
  return out;
}

// ---------- CSV export (header "Export" button) ----------
function exportCsv(months, rows, tot, scopeLabel) {
  const trendCols = [{ key: 'label', label: 'Month', type: 'text' }, { key: 'paid', label: 'Income', type: 'money' }, { key: 'actualCosts', label: 'Expenses', type: 'money' }, { key: 'result', label: 'Net', type: 'money' }, { key: 'cumulative', label: 'Net total', type: 'money' }];
  const projCols = [{ key: 'clientName', label: 'Client', type: 'text' }, { key: 'projectName', label: 'Project', type: 'text' }, { key: 'paid', label: 'Paid income', type: 'money' }, { key: 'costs', label: 'Recorded costs', type: 'money' },
    { key: 'net', label: 'Net profit', type: 'money', value: (r) => r.paid.sub(r.costs) }, { key: 'salesFees', label: 'Sales fee', type: 'money' }, { key: 'actualResult', label: 'Margin / net balance', type: 'money' }, { key: 'margin', label: 'Margin', type: 'pct' }];
  const strip = (s) => s.replace(/^﻿/, '');
  const text = toCSV([{ key: 'k', label: `Dashboard — ${scopeLabel}`, type: 'text' }], [])
    + '\r\n' + strip(toCSV(trendCols, months.map((m) => ({ ...m, label: monthLabel(m.month) }))))
    + '\r\n' + strip(toCSV(projCols, rows, { totals: { ...tot, clientName: 'Total', projectName: '' } }));
  downloadText(`dashboard_${stampForFile()}.csv`, text, 'text/csv');
}

export function renderDashboard(container) {
  const r = scopeRange();
  const idx = app.idx;
  const c = companyTotals(idx, r);
  const owed = Dec.sum(salesSummary(idx).map((s) => s.owed));
  const mrr = monthlyRecurringRevenue(idx, r);
  const qtd = quarterToDateComparison(idx);
  const rows = projectRows(idx, { from: r.from, to: r.to, clientOnly: true });
  const tot = totalRow(rows);
  // Every month from the first to the last with records (empty months as zero, so the time axis is even), with the
  // running net total from the start of the selected scope.
  let running = Dec.zero();
  const months = fillMonths(monthlyCompany(idx, r)).map((m) => ({ ...m, cumulative: (running = running.add(m.result)) }));
  const rerender = () => renderDashboard(container);
  app.exportCurrent = () => exportCsv(months, rows, tot, r.label);

  const scopeSel = h('select', { id: 'dash-scope', 'aria-label': 'Dashboard scope', onchange: () => { scopeState.scope = scopeSel.value; viewState.page = 0; rerender(); } },
    [['all', 'All time'], ['month', 'This month'], ['last', 'Last month'], ['year', 'This year'], ['custom', 'Custom range']].map(([v, l]) => h('option', { value: v }, l)));
  scopeSel.value = scopeState.scope;
  const dateInput = (key, label) => h('label', { class: 'dash-date' }, h('span', { class: 'sr-only' }, label),
    h('input', { type: 'date', 'aria-label': label, value: scopeState[key] || '', onchange: (e) => { scopeState[key] = e.target.value || null; viewState.page = 0; rerender(); } }));
  const custom = scopeState.scope === 'custom' ? [dateInput('from', 'From'), h('span', { class: 'muted' }, '–'), dateInput('to', 'To')] : null;

  const hasData = app.ds.income.length || app.ds.costs.length || app.ds.timeEntries.length || app.ds.activities.length;
  const avgPerHour = c.hoursWorked.isZero() ? null : c.income.div(c.hoursWorked, 10);
  const margin = c.income.isZero() ? null : c.netAfterOwner.div(c.income, 10);
  const segBtn = (mode, label) => h('button', { type: 'button', class: 'dash-seg-btn', 'aria-pressed': String(viewState.trend === mode), onclick: () => { viewState.trend = mode; rerender(); } }, label);

  replace(container, h('div', { class: 'dash' },
    h('div', { class: 'dash-head' },
      h('div', {},
        h('h1', {}, 'Dashboard'),
        h('p', { class: 'dash-lead' }, 'Actual results use paid income, recorded costs and earned sales fees. Analytical time value is shown separately and never reduces the actual result.')),
      h('div', { class: 'dash-scope' }, h('span', { class: 'dash-scope-label' }, 'Scope'), scopeSel, custom)),
    h('p', { class: 'dash-scope-note' }, r.label),
    !hasData ? h('section', { class: 'dash-card dash-empty' }, h('h2', {}, 'Welcome'), h('p', {}, 'No business records yet. Start with ', h('a', { href: '#/clients' }, 'Clients'), ' → ', h('a', { href: '#/projects' }, 'Projects'), ' → ', h('a', { href: '#/people' }, 'Employees & Rates'), ', then record income, costs and time. The internal client and its six cost centres are already set up.')) : null,
    h('section', { class: 'dash-kpis', 'aria-label': 'Headline figures' },
      kpi('Paid income', fmtMoney(c.income), { accent: 'primary' }),
      kpi('Actual costs', fmtMoney(c.actualCosts), { accent: 'secondary', sub: `Recorded costs ${fmtMoney(c.recordedCosts)} + earned sales fees ${fmtMoney(c.salesFees)}` }),
      kpi('Result before owner salary', fmtMoney(c.beforeOwner), { accent: 'tertiary', tone: toneOf(c.beforeOwner), sub: `Owner salary recorded: ${fmtMoney(c.ownerSalary)}` }),
      kpi('Net after owner salary', fmtMoney(c.netAfterOwner), { accent: 'primary-container', tone: toneOf(c.netAfterOwner),
        foot: [h('span', { class: `dash-badge ${margin !== null && sign(margin) < 0 ? 'dash-badge-neg' : 'dash-badge-pos'}` }, `Margin ${fmtMargin(margin)}`)] }),
      kpi('MRR (monthly recurring)', mrr ? fmtMoney(mrr.mrr) : '—', { accent: 'outline', sub: mrr ? `Paid income ${fmtMoney(mrr.income)} ÷ ${mrr.months} month${mrr.months === 1 ? '' : 's'} (${monthLabel(mrr.from.slice(0, 7))} – ${monthLabel(mrr.to.slice(0, 7))})` : 'No paid income up to today in this scope' }),
      // A percentage needs a non-zero base; when last quarter's net was 0 the money difference is shown instead.
      kpi('Quarterly performance', qtd.change === null ? fmtSignedMoney(qtd.difference) : fmtChange(qtd.change), {
        accent: 'tertiary', tone: sign(qtd.difference) < 0 ? 'neg' : sign(qtd.difference) > 0 ? 'pos' : null,
        sub: `Net: ${qtd.quarter} first ${qtd.days} day${qtd.days === 1 ? '' : 's'} ${fmtMoney(qtd.current)} vs ${fmtMoney(qtd.previous)} in ${qtd.previousQuarter}${qtd.change === null ? ' (no net to compare as %)' : ''} · any scope`,
      }),
      kpi('Commission owed', fmtMoney(owed), { accent: 'amber', tone: toneOf(owed), sub: 'All-time balance (earned − paid out), any scope' }),
      kpi('Hours worked', fmtHours(c.hoursWorked), { accent: 'primary',
        foot: [h('span', { title: 'Paid income ÷ hours worked in this scope' }, avgPerHour === null ? 'Avg: —' : `Avg: ${fmtMoney(avgPerHour)}/hr`), h('span', { class: 'dash-kpi-ico' }, icon.clock())] })),
    h('section', { class: 'dash-card' },
      h('div', { class: 'dash-card-head' },
        h('div', {}, h('h2', {}, 'Monthly trend'), h('p', { class: 'dash-sub' }, 'Expenses = recorded costs + earned sales fees · Net total = running total of income − expenses')),
        h('div', { class: 'dash-trend-tools' },
          h('div', { class: 'dash-legend' }, SERIES.map((s) => h('span', { class: `lg ${s.cls}` }, s.name))),
          h('div', { class: 'dash-seg', role: 'group', 'aria-label': 'Chart values' }, segBtn('monthly', 'Monthly curve'), segBtn('cumulative', 'Cumulative')))),
      months.length ? [trendChart(months, viewState.trend), ledger(months)] : h('p', { class: 'muted' }, 'No dated records in this scope.')),
    h('section', { class: 'dash-card' },
      h('div', { class: 'dash-card-head' },
        h('h2', {}, 'Client project results'),
        h('a', { class: 'dash-link', href: '#/reports/project-lifetime' }, 'Full report', icon.arrowRight())),
      projectTable(rows, tot, rerender))));
}
