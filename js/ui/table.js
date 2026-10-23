// Sortable data table with sticky header, formatted cells and a totals row.
import { h, replace } from './dom.js';
import { Dec } from '../lib/decimal.js';
import { fmtMoney, fmtHours, fmtMargin, fmtRate, fmtInt, fmtDate } from '../lib/format.js';

const NUMERIC = new Set(['money', 'hours', 'pct', 'rate', 'int', 'auto']);
const CENTER = new Set(['date', 'int']);

export function formatCell(type, v) {
  switch (type) {
    case 'money': return fmtMoney(v);
    case 'hours': return fmtHours(v);
    case 'pct': return fmtMargin(v);
    case 'rate': return fmtRate(v);
    case 'int': return fmtInt(v);
    case 'date': return fmtDate(v);
    default: return v === null || v === undefined ? '' : String(v);
  }
}

function cmp(a, b) {
  if (a === b) return 0;
  if (a === null || a === undefined || a === '') return 1;
  if (b === null || b === undefined || b === '') return -1;
  if (a instanceof Dec || b instanceof Dec) return Dec.from(a).cmp(Dec.from(b));
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
}

const val = (c, r) => (c.value ? c.value(r) : r[c.key]);

// Alignment: names/text left, figures right (tabular), counts and pills centred (c.align overrides).
const alignOf = (c, type) => (c.align ? `al-${c.align}` : NUMERIC.has(c.type) || NUMERIC.has(type) ? 'num' : CENTER.has(type) ? 'center' : '');

// body = a data row (blank cells show a muted dash); totals rows stay empty where there is no figure.
function cell(c, r, tag = 'td', body = false) {
  const type = c.type === 'auto' ? (r.type || 'money') : c.type;
  const v = val(c, r);
  const text = formatCell(type, v);
  const cls = [alignOf(c, type), type === 'date' ? 'date' : '', type === 'longtext' ? 'wrap' : '', type === 'mono' ? 'mono selectable' : '', c.strong ? 'strong' : ''];
  const signed = c.signed || r.signed;
  if (signed && v instanceof Dec) cls.push(v.round(2).sign() < 0 ? 'neg' : v.round(2).sign() > 0 ? 'pos' : '');
  let content = c.render ? c.render(r) : (type === 'mono' && (v === null || v === '') ? h('span', { class: 'muted' }, 'Not recorded') : text);
  if (body && (content === null || content === undefined || content === '' || content === '—')) content = h('span', { class: 'blank', 'aria-label': 'none' }, '—');
  return h(tag, { class: cls.filter(Boolean).join(' ') || null, title: type === 'pct' && v === null ? 'Unavailable (no income)' : null }, content);
}

// Status / category pill. tone: pos | warn | neg | neutral | brand. dot adds a leading status dot.
export const pill = (text, tone = 'neutral', { dot = false, title = null } = {}) =>
  h('span', { class: `pill pill-${tone}`, title }, dot ? h('span', { class: 'pill-dot', 'aria-hidden': 'true' }) : null, text);

// Small inline glyphs used by list screens (search field, external links).
export const glyph = {
  search: () => svgPath('M21 21l-5.2-5.2M10.5 18a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 0 15z'),
  external: () => svgPath('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
};
function svgPath(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '14', height: '14', 'aria-hidden': 'true', class: 'icon' })) s.setAttribute(k, v);
  const p = document.createElementNS(ns, 'path');
  for (const [k, v] of Object.entries({ d, fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) p.setAttribute(k, v);
  s.append(p);
  return s;
}

const isBlank = (v) => v === null || v === undefined || v === '';
const defaultIdOf = (r) => r.id ?? r.incomeId ?? null;

// opts: { columns, rows, totals, actions(row) -> nodes, onOpen(row), empty, noSort, caption, showDetail, idOf(row) }
// Default order: newest first by the table's first date column (or month); ties and date-less record lists
// fall back to the newest record ID first. Clicking a heading re-sorts; blanks always sort last.
export function dataTable(opts) {
  const idOf = opts.idOf || defaultIdOf;
  const dateCol = opts.columns.find((c) => c.type === 'date') || opts.columns.find((c) => c.sortKey === 'month');
  const state = { key: !opts.noSort && dateCol ? (dateCol.sortKey || dateCol.key) : null, dir: -1 };
  const wrap = h('div', { class: 'table-wrap', tabindex: '0', role: 'region', 'aria-label': opts.caption || 'Records table' });
  const newestId = (a, b) => { const x = idOf(a), y = idOf(b); return x === null || y === null ? 0 : y - x; };
  const render = () => {
    const cols = opts.columns.filter((c) => !c.detail || opts.showDetail);
    let rows = [...opts.rows];
    const c = state.key ? opts.columns.find((x) => (x.sortKey || x.key) === state.key) : null;
    if (c) {
      const sv = (r) => (c.sortKey ? r[c.sortKey] : val(c, r));
      rows.sort((a, b) => { const va = sv(a), vb = sv(b); if (isBlank(va) !== isBlank(vb)) return isBlank(va) ? 1 : -1; return state.dir * cmp(va, vb) || newestId(a, b); });
    } else if (!opts.noSort && opts.idOf) rows.sort(newestId);
    const head = h('tr', {}, cols.map((c) => {
      const k = c.sortKey || c.key;
      const sorted = state.key === k;
      const th = h('th', { scope: 'col', class: alignOf(c, c.type) || null, title: c.title || null, 'aria-sort': sorted ? (state.dir > 0 ? 'ascending' : 'descending') : null });
      if (opts.noSort) th.append(c.label);
      else th.append(h('button', { type: 'button', class: 'th-sort', onclick: () => { state.dir = state.key === k ? -state.dir : 1; state.key = k; render(); } }, c.label, h('span', { class: 'sort-ind', 'aria-hidden': 'true' }, sorted ? (state.dir > 0 ? ' ▲' : ' ▼') : '')));
      return th;
    }), opts.actions ? h('th', { scope: 'col', class: 'actions-col no-print' }, h('span', { class: 'sr-only' }, 'Actions')) : null);
    const body = rows.length
      ? rows.map((r) => h('tr', { class: [r.kind ? `row-${r.kind}` : '', opts.onOpen ? 'clickable' : ''].filter(Boolean).join(' ') || null, ondblclick: opts.onOpen ? () => opts.onOpen(r) : null },
        cols.map((c) => cell(c, r, 'td', true)), opts.actions ? h('td', { class: 'actions no-print' }, opts.actions(r)) : null))
      : [h('tr', {}, h('td', { class: 'empty', colspan: String(cols.length + (opts.actions ? 1 : 0)) }, opts.empty || 'No records yet.'))];
    const foot = opts.totals && rows.length ? h('tfoot', {}, h('tr', { class: 'row-total' }, cols.map((c) => cell(c, opts.totals)), opts.actions ? h('td', { class: 'no-print' }) : null)) : null;
    replace(wrap, h('table', { class: 'data' }, opts.caption ? h('caption', { class: 'sr-only' }, opts.caption) : null, h('thead', {}, head), h('tbody', {}, body), foot));
  };
  render();
  wrap.rerender = (patch = {}) => { Object.assign(opts, patch); render(); };
  return wrap;
}
