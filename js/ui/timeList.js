// Time Entries list: one table grouped by week, then day (newest first), with week and day totals. Within a day,
// entries with the same description, project and employee are folded into one row with a count (click to expand).
// Each row has Resume, which starts the timer with that description, project and employee.
// Replaces the generic table on that screen; CSV export still uses the screen's columns.
import { h, icon } from './dom.js';
import { Dec } from '../lib/decimal.js';
import { todayISO, addDays } from '../lib/dates.js';
import { fmtMoney, fmtHours } from '../lib/format.js';
import { app } from './state.js';
import { clientNameById } from '../calc/calc.js';
import { resumeTimer } from './timeTracker.js';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKS_PER_PAGE = 8;
const COLS = 6;

const weekday = (iso) => new Date(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10))).getUTCDay();
const weekStart = (iso) => addDays(iso, -weekday(iso));
const shortDate = (iso) => `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}`;
const dec = (v) => (v === null || v === undefined ? Dec.zero() : Dec.from(v));
const hours = (d) => `${fmtHours(d.round(2))} h`;
const total = (rows, k) => Dec.sum(rows.map((r) => dec(r[k])));
const expanded = new Set(); // grouped rows the user opened ("date|key"), kept across redraws
const similarKey = (r) => `${(r.task || '').trim().toLowerCase()}|${r.projectId}|${r.personId}`;
// Same-day entries with the same description, project and employee, in list order.
function similar(rows) {
  const m = new Map();
  for (const r of rows) { const k = similarKey(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
  return [...m.values()];
}

function dayTitle(iso, today) {
  const label = `${DAYS[weekday(iso)]}, ${shortDate(iso)}${iso.slice(0, 4) === today.slice(0, 4) ? '' : `, ${iso.slice(0, 4)}`}`;
  if (iso === today) return `Today · ${label}`;
  if (iso === addDays(today, -1)) return `Yesterday · ${label}`;
  return label;
}
function weekTitle(start, today) {
  const cur = weekStart(today);
  if (start === cur) return 'This week';
  if (start === addDays(cur, -7)) return 'Last week';
  const range = `${shortDate(start)} – ${shortDate(addDays(start, 6))}, ${addDays(start, 6).slice(0, 4)}`;
  return start > cur ? `${range} (upcoming)` : range;
}

// Group rows into [{ start, days: [{ date, rows }] }], newest first.
function group(rows) {
  const sorted = [...rows].sort((a, b) => (a.date === b.date ? b._rec.TimeEntryID - a._rec.TimeEntryID : a.date < b.date ? 1 : -1));
  const weeks = [];
  for (const r of sorted) {
    const ws = weekStart(r.date);
    let w = weeks[weeks.length - 1];
    if (!w || w.start !== ws) weeks.push(w = { start: ws, days: [] });
    let d = w.days[w.days.length - 1];
    if (!d || d.date !== r.date) w.days.push(d = { date: r.date, rows: [] });
    d.rows.push(r);
  }
  return weeks;
}

// ctx: { open(row), remove(row), describe(row), colorOf(projectId), empty }
export function timeList(rows, ctx) {
  if (!rows.length) return h('p', { class: 'te-empty muted' }, ctx.empty);
  const today = todayISO();
  const weeks = group(rows.filter((r) => r.date));

  const taskText = (r) => r.task || h('span', { class: 'muted' }, '(no description)');
  const projectCell = (r) => {
    const p = app.idx.projects.get(r.projectId);
    return h('td', { class: 'te-project' },
      h('span', { class: 'te-dot', style: `background:${ctx.colorOf(r.projectId)}`, 'aria-hidden': 'true' }),
      h('span', { class: 'te-pname' }, p?.ProjectName ?? `#${r.projectId}`),
      h('span', { class: 'te-sep', 'aria-hidden': 'true' }, '•'),
      h('span', { class: 'te-client' }, clientNameById(app.idx, p?.ClientID)));
  };
  const personCell = (r) => { const name = r.employee || ''; return h('td', { class: 'te-person' }, h('span', { class: 'te-avatar', 'aria-hidden': 'true' }, name.trim().charAt(0).toUpperCase() || '?'), name); };
  const resumeBtn = (r) => h('button', { type: 'button', class: 'btn-icon te-resume', title: 'Resume: start the timer with this description, project and employee', 'aria-label': `Resume ${ctx.describe(r)}`,
    onclick: (e) => { e.stopPropagation(); resumeTimer({ task: r.task || '', projectId: r.projectId, personId: r.personId }); } }, icon.play());

  const entry = (r, child = false) => h('tr', { class: `te-row${child ? ' te-child' : ''}`, tabindex: '0', 'aria-label': `Edit ${ctx.describe(r)}`,
    onclick: () => ctx.open(r), onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); ctx.open(r); } } },
  h('td', { class: 'te-task' }, taskText(r)),
  projectCell(r), personCell(r),
  h('td', { class: 'te-value', title: r.hourly ? `${fmtMoney(r.hourly)} / hour` : '' }, r.value ? fmtMoney(r.value) : h('span', { class: 'muted' }, '—')),
  h('td', { class: 'te-hours' }, h('span', { class: 'te-worked' }, hours(dec(r.worked)))),
  h('td', { class: 'te-actions no-print' },
    resumeBtn(r),
    h('button', { type: 'button', class: 'btn-icon', title: 'Edit', 'aria-label': `Edit ${ctx.describe(r)}`, onclick: (e) => { e.stopPropagation(); ctx.open(r); } }, icon.edit()),
    h('button', { type: 'button', class: 'btn-icon btn-icon-danger', title: 'Delete', 'aria-label': `Delete ${ctx.describe(r)}`, onclick: (e) => { e.stopPropagation(); ctx.remove(r); } }, icon.trash())));

  // Several similar entries on one day: a summary row with the count and totals; its entries open underneath.
  const groupRows = (rows, date) => {
    if (rows.length === 1) return [entry(rows[0])];
    const r = rows[0], id = `${date}|${similarKey(r)}`;
    const kids = rows.map((x) => { const k = entry(x, true); k.hidden = !expanded.has(id); return k; });
    const toggle = () => {
      if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
      const open = expanded.has(id);
      for (const k of kids) k.hidden = !open;
      count.setAttribute('aria-expanded', String(open)); tr.classList.toggle('open', open);
    };
    const count = h('button', { type: 'button', class: 'te-count', 'aria-expanded': String(expanded.has(id)), title: `Show the ${rows.length} entries`, 'aria-label': `Show the ${rows.length} entries`, onclick: (e) => { e.stopPropagation(); toggle(); } }, String(rows.length));
    const values = rows.filter((x) => x.value);
    const tr = h('tr', { class: `te-row te-group-row${expanded.has(id) ? ' open' : ''}`, tabindex: '0', 'aria-label': `${rows.length} entries: ${ctx.describe(r)}. Press Enter to show them.`,
      onclick: toggle, onkeydown: (e) => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(); } } },
    h('td', { class: 'te-task' }, h('span', { class: 'te-task-line' }, count, taskText(r))),
    projectCell(r), personCell(r),
    h('td', { class: 'te-value' }, values.length ? fmtMoney(total(values, 'value')) : h('span', { class: 'muted' }, '—')),
    h('td', { class: 'te-hours' }, h('span', { class: 'te-worked' }, hours(total(rows, 'worked')))),
    h('td', { class: 'te-actions no-print' }, resumeBtn(r),
      h('button', { type: 'button', class: 'btn-icon te-chevron', title: 'Show or hide the entries', 'aria-hidden': 'true', tabindex: '-1', onclick: (e) => { e.stopPropagation(); toggle(); } }, icon.chevronRight())));
    return [tr, ...kids];
  };

  const renderWeek = (w, i) => {
    const all = w.days.flatMap((d) => d.rows);
    const current = w.start === weekStart(today);
    return h('tbody', {},
      h('tr', { class: 'te-week-row' }, h('td', { colspan: String(COLS) }, h('div', { class: 'te-group' },
        h('span', { class: 'te-week-title' }, h('span', { class: current ? 'te-week-icon current' : 'te-week-icon', 'aria-hidden': 'true' }, icon.calendar()), weekTitle(w.start, today)),
        h('span', {}, 'Week total: ', h('strong', { class: current ? 'teal' : null }, hours(total(all, 'worked'))))))),
      w.days.flatMap((d) => [
        h('tr', { class: 'te-day-row' }, h('td', { colspan: String(COLS) }, h('div', { class: 'te-group' },
          h('span', { class: 'te-day-title' }, dayTitle(d.date, today)),
          h('span', {}, 'Total: ', h('strong', {}, hours(total(d.rows, 'worked'))))))),
        ...similar(d.rows).flatMap((g) => groupRows(g, d.date)),
      ]));
  };

  const table = h('table', { class: 'te-table' },
    h('caption', { class: 'sr-only' }, 'Time entries grouped by week and day'),
    h('thead', {}, h('tr', {},
      h('th', { scope: 'col' }, 'Description'), h('th', { scope: 'col' }, 'Project & client'), h('th', { scope: 'col' }, 'Team member'),
      h('th', { scope: 'col', class: 'num' }, 'Value'), h('th', { scope: 'col', class: 'num' }, 'Hours'), h('th', { scope: 'col', class: 'te-actions-col no-print' }, 'Actions'))));
  let shown = 0;
  const more = h('button', { type: 'button', class: 'btn btn-small te-more', onclick: () => showMore() });
  function showMore() {
    const next = weeks.slice(shown, shown + WEEKS_PER_PAGE);
    table.append(...next.map(renderWeek));
    shown += next.length;
    const left = weeks.length - shown, n = Math.min(left, WEEKS_PER_PAGE);
    more.hidden = left <= 0;
    more.textContent = `Show ${n} more week${n === 1 ? '' : 's'} (${left} older)`;
  }
  showMore();
  return h('div', { class: 'te-list' }, h('div', { class: 'te-table-wrap' }, table), h('div', { class: 'te-more-row' }, more));
}
