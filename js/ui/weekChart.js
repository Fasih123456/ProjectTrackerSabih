// Weekly hours chart for the Time Entries screen: one stacked bar per day (Sun–Sat), coloured by project.
// It receives the rows that pass the page filters (search, client, project, employee) and has its own week navigation;
// picking a "From" date in the page filters jumps to that week. The table below stays authoritative.
import { h, replace, icon } from './dom.js';
import { fmtMoney } from '../lib/format.js';
import { Dec } from '../lib/decimal.js';
import { todayISO, addDays } from '../lib/dates.js';
import { clientNameById } from '../calc/calc.js';
import { app } from './state.js';
import { BASE_SYMBOL } from '../calc/fx.js';

// Fixed categorical order (validated palette); projects beyond the 7th fold into "Other" (grey).
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6'];
const OTHER = { key: 'other', name: 'Other projects', color: '#a3a6b4' };
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const weekday = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay();
const weekStart = (iso) => addDays(iso, -weekday(iso));
const dayLabel = (iso) => `${DAYS[weekday(iso)]}, ${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const shortDate = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const hrs = (n) => `${n.toFixed(2)} h`;
const longDate = (iso) => `${['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'][weekday(iso)]}, ${shortDate(iso)}`;
const short = (v) => (v >= 1e6 ? `${+(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${+(v / 1e3).toFixed(1)}k` : `${Math.round(v)}`);
const METRICS = {
  worked: { label: 'Hours worked', fmt: hrs, axis: (t) => `${+t.toFixed(2)}h`, bar: (v) => v.toFixed(2) },
  value: { label: 'Time value', fmt: (v) => fmtMoney(Dec.from(v.toFixed(2))), axis: short, bar: short },
};
const num = (v) => (v === null || v === undefined ? 0 : Dec.from(v).toNumber());

function niceMax(max) {
  if (max <= 0) return { top: 1, step: 0.25 };
  const raw = max / 4, mag = 10 ** Math.floor(Math.log10(raw)), n = raw / mag;
  const step = (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * mag;
  return { top: Math.ceil(max / step) * step, step };
}

export function weekChart() {
  const state = { week: weekStart(todayISO()), metric: 'worked', lastFrom: null };
  let rows = [];
  const ns = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs, text) => { const e = document.createElementNS(ns, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); if (text !== undefined) e.textContent = text; return e; };

  const subtitle = h('span', { class: 'wk-subtitle' });
  const metricSel = h('select', { class: 'wk-metric', 'aria-label': 'Measure shown', onchange: () => { state.metric = metricSel.value; render(); } },
    Object.entries(METRICS).map(([k, m]) => h('option', { value: k }, k === 'value' ? `Time value (${BASE_SYMBOL})` : m.label)));
  const go = (n) => { state.week = addDays(state.week, 7 * n); render(); };
  // The middle of the week switcher names the week; clicking it returns to the current week.
  const rangeBtn = h('button', { type: 'button', class: 'wk-range', 'aria-live': 'polite', onclick: () => { state.week = weekStart(todayISO()); render(); } });
  const controls = h('div', { class: 'wk-controls' }, metricSel,
    h('div', { class: 'wk-seg' },
      h('button', { type: 'button', class: 'wk-step', 'aria-label': 'Previous week', title: 'Previous week', onclick: () => go(-1) }, icon.chevronLeft()),
      rangeBtn,
      h('button', { type: 'button', class: 'wk-step', 'aria-label': 'Next week', title: 'Next week', onclick: () => go(1) }, icon.chevronRight())));
  const stats = h('div', { class: 'wk-stats' });
  const plot = h('div', { class: 'chart-plot wk-plot', tabindex: '0', role: 'img' });
  const tip = h('div', { class: 'chart-tip', hidden: true });
  const breakdown = h('div', { class: 'wk-share' });
  const root = h('section', { class: 'card chart wk-chart no-print' },
    h('div', { class: 'wk-head' }, h('div', { class: 'wk-title' }, h('h2', {}, 'Weekly hours'), subtitle), controls),
    stats,
    h('div', { class: 'wk-body' }, h('div', { class: 'wk-plot-col' }, plot), breakdown));

  let model = null, active = -1, geom = null, colors = new Map();

  // Colours are assigned by each project's total hours across all filtered rows (not just this week),
  // so a project keeps its colour while you move between weeks.
  function series() {
    const tot = new Map();
    for (const r of rows) tot.set(r.projectId, (tot.get(r.projectId) || 0) + num(r.worked)); // colour follows the project, whatever the measure
    const ranked = [...tot.keys()].sort((a, b) => tot.get(b) - tot.get(a) || a - b);
    const map = new Map();
    ranked.forEach((pid, i) => {
      const p = app.idx.projects.get(pid);
      map.set(pid, i < PALETTE.length ? { key: pid, name: p?.ProjectName ?? `#${pid}`, client: clientNameById(app.idx, p?.ClientID), color: PALETTE[i], order: i } : { ...OTHER, order: PALETTE.length });
    });
    return map;
  }

  function build() {
    const sMap = colors = series();
    const days = Array.from({ length: 7 }, (_, i) => ({ date: addDays(state.week, i), parts: new Map(), total: 0 }));
    const end = addDays(state.week, 6);
    const byProject = new Map(), byClient = new Map();
    for (const r of rows) {
      if (!r.date || r.date < state.week || r.date > end) continue;
      const v = num(r[state.metric]);
      const s = sMap.get(r.projectId);
      const d = days[weekday(r.date)];
      d.parts.set(s.key, { s, v: (d.parts.get(s.key)?.v || 0) + v });
      d.total += v;
      const p = app.idx.projects.get(r.projectId);
      byProject.set(r.projectId, { name: p?.ProjectName ?? `#${r.projectId}`, client: clientNameById(app.idx, p?.ClientID), color: s.color, order: s.order, v: (byProject.get(r.projectId)?.v || 0) + v });
      const cid = p?.ClientID ?? null;
      byClient.set(cid, (byClient.get(cid) || 0) + v);
    }
    for (const d of days) d.stack = [...d.parts.values()].sort((a, b) => a.s.order - b.s.order);
    const total = days.reduce((n, d) => n + d.total, 0);
    const projects = [...byProject.values()].filter((p) => p.v > 0).sort((a, b) => b.v - a.v);
    const topClient = [...byClient.entries()].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1])[0];
    return { days, total, projects, topClient: topClient ? clientNameById(app.idx, topClient[0]) : null };
  }

  function render() {
    model = build();
    const today = weekStart(todayISO());
    const end = addDays(state.week, 6);
    rangeBtn.textContent = state.week === today ? 'This week' : state.week === addDays(today, -7) ? 'Last week' : `${shortDate(state.week)} – ${shortDate(end)}`;
    rangeBtn.title = state.week === today ? `${state.week} to ${end}` : 'Go to this week';
    subtitle.textContent = `${longDate(state.week)} – ${longDate(end)}${end.slice(0, 4) === todayISO().slice(0, 4) ? '' : `, ${end.slice(0, 4)}`}`;
    const m = METRICS[state.metric];
    const stat = (ic, tone, k, v, extra) => h('div', { class: 'wk-stat' }, h('span', { class: `wk-stat-icon tone-${tone}`, 'aria-hidden': 'true' }, icon[ic]()),
      h('div', { class: 'wk-stat-text' }, h('div', { class: 'wk-stat-label' }, k), h('div', { class: 'wk-stat-value' }, v, extra ? h('span', { class: 'wk-stat-extra' }, ` (${extra})`) : null)));
    const top = model.projects[0];
    replace(stats,
      stat(state.metric === 'value' ? 'money' : 'clock', 'teal', `Total ${m.label.toLowerCase()}`, m.fmt(model.total)),
      stat('tag', 'amber', 'Top project', top?.name ?? '—', top ? m.fmt(top.v) : null),
      stat('store', 'indigo', 'Top client', model.topClient ?? '—'));
    plot.setAttribute('aria-label', `${m.label} per day, ${subtitle.textContent}, stacked by project. Total ${m.fmt(model.total)}. Use left and right arrow keys to read each day.`);
    const clients = new Set(model.projects.map((p) => p.client));
    replace(breakdown,
      h('div', { class: 'wk-share-head' }, h('span', {}, 'Project share'), h('span', {}, 'Weekly total')),
      model.projects.length
        ? model.projects.map((p) => h('div', { class: 'wk-item' },
          h('div', { class: 'wk-item-top' },
            h('span', { class: 'wk-name', title: `${p.name} · ${p.client}` }, h('span', { class: 'wk-swatch', style: `background:${p.color}` }), p.name),
            h('span', { class: 'wk-amt' }, m.fmt(p.v), h('span', { class: 'wk-pct' }, ` (${((100 * p.v) / model.total).toFixed(1)}%)`))),
          h('div', { class: 'wk-bar' }, h('span', { style: `width:${(100 * p.v) / model.total}%;background:${p.color}` }))))
        : h('p', { class: 'muted small' }, 'No time recorded in this week for the current filters.'),
      clients.size === 1 ? h('div', { class: 'wk-share-foot' }, `All for ${[...clients][0]}`) : null);
    draw();
  }

  function draw() {
    if (!model) return;
    const W = Math.max(300, plot.clientWidth || 700), H = 260, L = 46, R = 8, T = 26, B = 30;
    const m = METRICS[state.metric], today = todayISO();
    const { top, step } = niceMax(Math.max(...model.days.map((d) => d.total)));
    const y = (v) => T + (H - T - B) * (1 - v / top);
    const slot = (W - L - R) / 7, bw = Math.min(120, slot * 0.72);
    const x = (i) => L + slot * i + (slot - bw) / 2;
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}`, 'aria-hidden': 'true' });
    for (let t = 0; t <= top + step / 2; t += step) {
      svg.append(el('line', { x1: L, x2: W - R, y1: y(t), y2: y(t), class: t === 0 ? 'baseline' : 'grid' }));
      svg.append(el('text', { x: L - 8, y: y(t) + 4, class: 'axis', 'text-anchor': 'end' }, m.axis(t)));
    }
    const hits = [];
    model.days.forEach((d, i) => {
      let base = 0;
      const g = el('g', { class: 'wk-day' });
      d.stack.forEach((p, k) => {
        const y0 = y(base), y1 = y(base + p.v);
        // 2px surface gap between stacked segments; rounded top only on the uppermost segment.
        const hgt = Math.max(0, y0 - y1 - (k ? 2 : 0));
        if (hgt > 0) g.append(k === d.stack.length - 1 ? el('path', { d: topRounded(x(i), y1, bw, hgt, 4), fill: p.s.color }) : el('rect', { x: x(i), y: y1, width: bw, height: hgt, fill: p.s.color }));
        base += p.v;
      });
      svg.append(g);
      if (d.total > 0) svg.append(el('text', { x: x(i) + bw / 2, y: y(d.total) - 7, class: 'axis wk-total', 'text-anchor': 'middle' }, m.bar(d.total)));
      else svg.append(el('text', { x: x(i) + bw / 2, y: y(0) - 6, class: 'axis wk-zero', 'text-anchor': 'middle' }, '0'));
      svg.append(el('text', { x: x(i) + bw / 2, y: H - 9, class: `axis${d.date === today ? ' wk-today' : ''}`, 'text-anchor': 'middle' }, slot < 80 ? DAYS[i] : dayLabel(d.date)));
      hits.push(g);
    });
    replace(plot, svg, tip);
    geom = { slot, L, W, x, bw, hits };
    if (active >= 0) show(active);
  }

  const topRounded = (x0, y0, w, hgt, r) => {
    r = Math.min(r, hgt, w / 2);
    return `M${x0},${y0 + hgt}V${y0 + r}Q${x0},${y0} ${x0 + r},${y0}H${x0 + w - r}Q${x0 + w},${y0} ${x0 + w},${y0 + r}V${y0 + hgt}Z`;
  };

  function show(i) {
    if (!geom) return;
    active = i;
    const d = model.days[i];
    geom.hits.forEach((g, j) => g.setAttribute('opacity', j === i ? '1' : '0.45'));
    const fmt = METRICS[state.metric].fmt;
    replace(tip, h('div', { class: 'tip-title' }, `${dayLabel(d.date)} · ${fmt(d.total)}`),
      d.stack.length ? [...d.stack].sort((a, b) => b.v - a.v).map((p) => h('div', { class: 'tip-row' }, h('span', {}, h('span', { class: 'wk-swatch', style: `background:${p.s.color}` }), p.s.name), h('span', { class: 'tip-val' }, fmt(p.v)))) : h('div', { class: 'muted' }, 'No time recorded'));
    tip.hidden = false;
    const tw = tip.offsetWidth || 200, cx = geom.x(i) + geom.bw / 2;
    tip.style.left = `${Math.min(Math.max(cx + geom.bw / 2 + 8 + tw > geom.W ? cx - geom.bw / 2 - tw - 8 : cx + geom.bw / 2 + 8, 0), geom.W - tw)}px`;
  }
  function hide() { active = -1; tip.hidden = true; geom?.hits.forEach((g) => g.removeAttribute('opacity')); }
  plot.addEventListener('pointermove', (e) => { if (!geom) return; const i = Math.floor((e.clientX - plot.getBoundingClientRect().left - geom.L) / geom.slot); if (i >= 0 && i < 7) show(i); else hide(); });
  plot.addEventListener('pointerleave', hide);
  plot.addEventListener('blur', hide);
  plot.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); const dir = e.key === 'ArrowRight' ? 1 : -1; show(active < 0 ? (dir > 0 ? 0 : 6) : Math.min(6, Math.max(0, active + dir))); }
    else if (e.key === 'Escape') hide();
  });
  new ResizeObserver(() => draw()).observe(plot);

  return {
    el: root,
    // Same colour as in the chart, so the list below can show matching project dots.
    colorOf: (pid) => colors.get(pid)?.color ?? OTHER.color,
    // Called by the list screen whenever the page filters change.
    update(filteredRows, st = {}) {
      rows = filteredRows;
      if (st.from && st.from !== state.lastFrom) state.week = weekStart(st.from);
      state.lastFrom = st.from || null;
      render();
    },
  };
}
