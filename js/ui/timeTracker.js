// Time tracker bar on the Time Entries screen: a stopwatch (Start / Stop) or manual start and end times (Add).
// The running timer is kept in localStorage as its start time plus task/project/employee, so it keeps running
// across reloads and while other screens are open. Saved entries are ordinary time entries (decimal hours,
// hours billed = hours worked).
import { h, replace, toast, icon, confirmDialog } from './dom.js';
import { app, projectHiddenReason, personOptions } from './state.js';
import { blankRecord } from '../model/schema.js';
import { validateRecord, ctxFromDataset } from '../model/validate.js';
import { todayISO, addDays } from '../lib/dates.js';
import { clientLabel, defaultHourly } from '../calc/calc.js';
import { fmtMoney } from '../lib/format.js';

const TIMER_KEY = 'spt.timer', MODE_KEY = 'spt.timerMode', PERSON_KEY = 'spt.timerPerson';
const PALETTE = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#8a5a44'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const load = (k) => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } };
const store = (k, v) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } };

const pad = (n) => String(n).padStart(2, '0');
const hms = (sec) => { sec = Math.max(0, Math.floor(sec)); return `${pad(Math.floor(sec / 3600))}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`; };
const hhmm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const minutesOf = (t) => (/^\d{2}:\d{2}$/.test(t || '') ? +t.slice(0, 2) * 60 + +t.slice(3) : null);
const timeOf = (min) => { min = ((min % 1440) + 1440) % 1440; return `${pad(Math.floor(min / 60))}:${pad(min % 60)}`; };
// Decimal hours as stored (two decimals): 1h 15m -> 1.25.
const toHours = (sec) => Math.round(sec / 36) / 100;
// "1:30", "1:30:00" or decimal hours "1.5" -> seconds (null when not understood).
function parseDuration(text) {
  const t = (text || '').trim();
  let m = /^(\d+):([0-5]?\d)(?::([0-5]?\d))?$/.exec(t);
  if (m) return +m[1] * 3600 + +m[2] * 60 + +(m[3] || 0);
  m = /^\d+(?:\.\d+)?$/.exec(t);
  return m ? Math.round(+t * 3600) : null;
}
function dateLabel(iso) {
  const today = todayISO();
  if (iso === today) return 'Today';
  if (iso === addDays(today, -1)) return 'Yesterday';
  return `${MONTHS[+iso.slice(5, 7) - 1]} ${+iso.slice(8, 10)}${iso.slice(0, 4) === today.slice(0, 4) ? '' : `, ${iso.slice(0, 4)}`}`;
}

export const projectColor = (id) => PALETTE[(Number(id) || 0) % PALETTE.length];
function projectName(id) {
  const p = app.idx.projects.get(id);
  if (!p) return null;
  const c = app.idx.clients.get(p.ClientID);
  return p.ProjectType === 'Internal' || c?.IsInternal ? p.ProjectName : `${clientLabel(c)} - ${p.ProjectName}`;
}

// Selectable projects grouped by client (internal cost centres last); archived / contract-ended projects are left out.
function projectGroups() {
  const groups = new Map();
  for (const p of app.ds.projects) {
    if (projectHiddenReason(p)) continue;
    const c = app.idx.clients.get(p.ClientID);
    const internal = p.ProjectType === 'Internal' || !!c?.IsInternal;
    const key = internal ? 'internal' : p.ClientID;
    if (!groups.has(key)) groups.set(key, { label: internal ? 'Internal' : clientLabel(c), internal, projects: [] });
    groups.get(key).projects.push(p);
  }
  const byName = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  for (const g of groups.values()) g.projects.sort((a, b) => byName(a.ProjectName, b.ProjectName));
  return [...groups.values()].sort((a, b) => (a.internal - b.internal) || byName(a.label, b.label));
}

// "+ Project" button that opens a searchable list of projects grouped by client.
function projectPicker(getId, onPick) {
  const btn = h('button', { type: 'button', class: 'tt-project-btn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', onclick: () => (pop.hidden ? open() : close()) });
  const search = h('input', { type: 'search', class: 'tt-pop-search', placeholder: 'Find project or client…', 'aria-label': 'Find project or client', oninput: () => fill() });
  const list = h('div', { class: 'tt-pop-list', role: 'listbox', 'aria-label': 'Projects' });
  const pop = h('div', { class: 'tt-pop', hidden: true, onkeydown: (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(); btn.focus(); } } },
    search, list,
    h('a', { class: 'tt-pop-new', href: '#/projects?new=1' }, icon.plus(), 'Create new project'));
  const wrap = h('div', { class: 'tt-project' }, btn, pop);
  const outside = (e) => { if (!wrap.contains(e.target)) close(); };

  function label() {
    const id = getId();
    const name = id ? projectName(id) : null;
    replace(btn, name
      ? [h('span', { class: 'tt-dot', style: `background:${projectColor(id)}`, 'aria-hidden': 'true' }), h('span', { class: 'tt-project-name', style: `color:${projectColor(id)}` }, name)]
      : [h('span', { class: 'tt-plus', 'aria-hidden': 'true' }, icon.plus()), 'Project']);
    btn.title = name ? `Project: ${name} (click to change)` : 'Choose a project';
  }
  function fill() {
    const q = search.value.trim().toLowerCase();
    const current = getId();
    const groups = projectGroups().map((g) => ({ ...g, projects: g.projects.filter((p) => !q || p.ProjectName.toLowerCase().includes(q) || g.label.toLowerCase().includes(q)) })).filter((g) => g.projects.length);
    replace(list, groups.length ? groups.map((g) => h('div', { class: 'tt-pop-group', role: 'group', 'aria-label': g.label },
      h('div', { class: 'tt-pop-client' }, h('span', {}, g.label), h('span', { class: 'tt-pop-count' }, `${g.projects.length} project${g.projects.length === 1 ? '' : 's'}`)),
      g.projects.map((p) => h('button', { type: 'button', role: 'option', class: 'tt-pop-item', 'aria-selected': String(p.ProjectID === current),
        onclick: () => { onPick(p.ProjectID); label(); close(); btn.focus(); } },
      h('span', { class: 'tt-dot', style: `background:${projectColor(p.ProjectID)}`, 'aria-hidden': 'true' }),
      h('span', { style: `color:${projectColor(p.ProjectID)}` }, p.ProjectName)))))
      : h('p', { class: 'tt-pop-empty muted' }, q ? 'No matching projects.' : 'No active projects yet.'));
  }
  function open() {
    search.value = ''; fill();
    pop.hidden = false; btn.setAttribute('aria-expanded', 'true');
    setTimeout(() => { search.focus(); document.addEventListener('mousedown', outside); }, 0);
  }
  function close() { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); document.removeEventListener('mousedown', outside); }
  label();
  return { el: wrap, open, refresh: label };
}

// Stores one time entry. Returns true when saved; the caller then clears its own state and calls refresh().
async function saveEntry({ date, seconds, projectId, personId, task }) {
  const hours = toHours(seconds);
  const rec = { ...blankRecord('timeEntries'), WorkDate: date, ProjectID: projectId, PersonID: personId, WorkTask: task?.trim() || null, HoursWorked: hours, HoursBilled: hours, RateOverride: null };
  const errs = validateRecord('timeEntries', rec, ctxFromDataset(app.ds), null);
  if (Object.keys(errs).length) { toast('Not saved: ' + Object.values(errs).join(' '), 'error', 7000); return false; }
  try {
    const saved = await app.db.create('timeEntries', rec);
    toast(`Time entry saved (#${saved.TimeEntryID}): ${hours.toFixed(2)} h on ${projectName(projectId)}.`);
    return true;
  } catch (e) { toast('Not saved: ' + (e.message || e), 'error', 8000); return false; }
}

const refresh = async () => { await app.reload(); app.render(); };

// Saves the running timer as a time entry (on the day it was started) and clears it. Returns false when it
// could not be saved (no project, or a storage error); the timer then keeps running.
async function saveRunning() {
  const t = load(TIMER_KEY);
  if (!t) return true;
  if (!t.projectId || !app.idx.projects.has(t.projectId)) { toast('Choose a project to save this time. The timer keeps running.', 'error', 5000); return false; }
  const seconds = (Date.now() - t.startedAt) / 1000;
  if (toHours(seconds) <= 0) { store(TIMER_KEY, null); toast('Less than a minute was tracked, so nothing was saved.', 'warn', 5000); return true; }
  if (!(await saveEntry({ date: todayISO(new Date(t.startedAt)), seconds, projectId: t.projectId, personId: t.personId, task: t.task }))) return false;
  store(TIMER_KEY, null);
  return true;
}

// Resume (from the Time Entries list): start the stopwatch with an entry's description, project and employee.
// A timer that is already running is saved first, after confirming.
export async function resumeTimer({ task, projectId, personId }) {
  const running = load(TIMER_KEY);
  if (running) {
    const what = running.task ? ` “${running.task}”` : '';
    if (!(await confirmDialog(`A timer is already running${what} (${hms((Date.now() - running.startedAt) / 1000)}). Stop and save it, then start this one?`, { title: 'Timer already running', ok: 'Save it and start' }))) return;
    if (!(await saveRunning())) return;
  }
  store(TIMER_KEY, { startedAt: Date.now(), task: task || '', projectId, personId });
  store(MODE_KEY, 'timer');
  await refresh();
  document.querySelector('.tt-bar')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// Rough cost of the running timer: the employee's default hourly value x time so far.
function roughCost(t) {
  const person = app.idx.people.get(t.personId);
  const hourly = defaultHourly(person);
  const hours = (Date.now() - t.startedAt) / 3600000;
  if (hourly === null) return `Rough cost: not available (${person ? person.PersonName + ' has' : 'this employee has'} no monthly salary / reference hours).`;
  return `Rough cost so far: ${fmtMoney(hourly.mul(hours.toFixed(4)))} (${fmtMoney(hourly)}/h × ${hours.toFixed(2)} h · ${person.PersonName}). Updated every minute.`;
}

// Text typed before Start / Add, kept while the screen re-renders.
const draft = { task: '', projectId: null, manual: { date: null, start: null, end: null } };

export function timeTracker() {
  const root = h('section', { class: 'card tt-bar no-print', 'aria-label': 'Time tracker' });
  let mode = load(MODE_KEY) === 'manual' ? 'manual' : 'timer';
  let lastTimer = JSON.stringify(load(TIMER_KEY));
  let tick = null;

  const people = () => personOptions();
  function personId() {
    const opts = people();
    const saved = load(PERSON_KEY);
    return opts.some((o) => o.value === saved) ? saved : opts[0]?.value ?? null;
  }
  const personSelect = (value, onPick) => {
    const opts = people();
    if (opts.length < 2) return null; // one employee: no need to ask
    const s = h('select', { class: 'tt-person', 'aria-label': 'Employee', title: 'Employee', onchange: () => { store(PERSON_KEY, +s.value); onPick(+s.value); } },
      opts.map((o) => h('option', { value: String(o.value) }, o.label)));
    s.value = String(value);
    return s;
  };
  const modeToggle = () => h('div', { class: 'tt-modes', role: 'group', 'aria-label': 'Tracking mode' },
    h('button', { type: 'button', class: `tt-mode${mode === 'timer' ? ' active' : ''}`, title: 'Timer mode', 'aria-label': 'Timer mode', 'aria-pressed': String(mode === 'timer'), onclick: () => setMode('timer') }, icon.clock()),
    h('button', { type: 'button', class: `tt-mode${mode === 'manual' ? ' active' : ''}`, title: 'Manual mode', 'aria-label': 'Manual mode', 'aria-pressed': String(mode === 'manual'), onclick: () => setMode('manual') }, icon.list()));
  function setMode(m) { mode = m; store(MODE_KEY, m); render(); }

  function renderTimer() {
    const running = load(TIMER_KEY);
    const st = running || draft;
    const update = (patch) => { if (running) { Object.assign(running, patch); store(TIMER_KEY, running); lastTimer = JSON.stringify(running); } else Object.assign(draft, patch); };
    const task = h('input', { type: 'text', class: 'tt-task', placeholder: 'What are you working on?', 'aria-label': 'What are you working on?', value: st.task || '', maxlength: '255',
      oninput: () => update({ task: task.value }), onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); running ? stop() : start(); } } });
    const picker = projectPicker(() => st.projectId, (id) => update({ projectId: id }));
    const clock = h('span', { class: `tt-clock${running ? ' running' : ''}`, role: 'timer', 'aria-label': 'Elapsed time' }, hms(running ? (Date.now() - running.startedAt) / 1000 : 0));
    const who = running ? running.personId : personId();
    const person = personSelect(who, (id) => update({ personId: id }));
    const btn = h('button', { type: 'button', class: `tt-go${running ? ' tt-stop' : ''}`, onclick: () => (running ? stop() : start()) }, running ? 'Stop' : 'Start');
    const cancel = running ? h('button', { type: 'button', class: 'tt-cancel', title: 'Cancel this timer: nothing is saved',
      onclick: async () => { if (await confirmDialog('Cancel the running timer? The time tracked so far is not saved.', { title: 'Cancel timer?', ok: 'Cancel timer', cancel: 'Keep running', danger: true })) { store(TIMER_KEY, null); lastTimer = 'null'; render(); } } }, 'Cancel') : null;

    const cost = running ? h('p', { class: 'tt-note muted small', 'aria-live': 'polite' }, roughCost(running)) : null;
    function start() {
      const pid = personId();
      if (pid === null) { toast('Add an employee first (Employees & Rates).', 'error'); return; }
      const t = { startedAt: Date.now(), task: task.value, projectId: draft.projectId, personId: pid };
      store(TIMER_KEY, t); lastTimer = JSON.stringify(t);
      draft.task = ''; draft.projectId = null;
      render();
    }
    async function stop() {
      btn.disabled = true;
      if (await saveRunning()) { lastTimer = 'null'; await refresh(); return; }
      btn.disabled = false;
      if (!load(TIMER_KEY)?.projectId) picker.open();
    }
    replace(root, h('div', { class: 'tt-row' }, task, h('div', { class: 'tt-cell' }, picker.el), person ? h('div', { class: 'tt-cell' }, person) : null,
      h('div', { class: 'tt-cell tt-cell-clock' }, clock), btn, cancel, modeToggle()),
    cost);
    if (running) {
      let n = 0;
      tick = setInterval(() => {
        if (!root.isConnected) { clearInterval(tick); return; }
        clock.textContent = hms((Date.now() - running.startedAt) / 1000);
        if (++n % 60 === 0) cost.textContent = roughCost(running); // recalculated every 60 seconds
      }, 1000);
    }
  }

  function renderManual() {
    const m = draft.manual;
    const now = hhmm(new Date());
    m.date ||= todayISO(); m.start ||= now; m.end ||= now;
    const seconds = () => { const s = minutesOf(m.start), e = minutesOf(m.end); return s === null || e === null ? 0 : (((e - s) % 1440) + 1440) % 1440 * 60; };
    const task = h('input', { type: 'text', class: 'tt-task', placeholder: 'What have you worked on?', 'aria-label': 'What have you worked on?', value: draft.task, maxlength: '255',
      oninput: () => { draft.task = task.value; }, onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } } });
    const picker = projectPicker(() => draft.projectId, (id) => { draft.projectId = id; });
    let pid = personId();
    const person = personSelect(pid, (id) => { pid = id; });
    const dur = h('input', { type: 'text', class: 'tt-duration', 'aria-label': 'Duration (h:mm:ss or decimal hours)', title: 'Duration: type 1:30 or 1.5 to set the end time', value: hms(seconds()),
      onchange: () => { const s = parseDuration(dur.value); if (s !== null && s < 86400) m.end = timeOf(minutesOf(m.start) + Math.round(s / 60)); endIn.value = m.end; dur.value = hms(seconds()); },
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); dur.dispatchEvent(new Event('change')); add(); } } });
    const timeInput = (key, label) => h('input', { type: 'time', class: 'tt-time', 'aria-label': label, value: m[key], onchange: (e) => { m[key] = e.target.value || m[key]; dur.value = hms(seconds()); } });
    const startIn = timeInput('start', 'Start time'), endIn = timeInput('end', 'End time');
    const dateText = h('span', {}, dateLabel(m.date));
    const dateIn = h('input', { type: 'date', class: 'tt-date-input', tabindex: '-1', 'aria-hidden': 'true', value: m.date, onchange: () => { if (dateIn.value) { m.date = dateIn.value; dateText.textContent = dateLabel(m.date); } } });
    const dateBtn = h('button', { type: 'button', class: 'tt-date', title: 'Work date', 'aria-label': 'Work date',
      onclick: () => { try { dateIn.showPicker(); } catch { dateIn.classList.add('tt-date-input-shown'); dateIn.focus(); } } }, icon.calendar(), dateText);
    const btn = h('button', { type: 'button', class: 'tt-go', onclick: () => add() }, 'Add');
    async function add() {
      if (pid === null) { toast('Add an employee first (Employees & Rates).', 'error'); return; }
      if (!draft.projectId) { toast('Choose a project first.', 'error'); picker.open(); return; }
      const s = seconds();
      if (!s) { toast('Set a start and end time (or type a duration).', 'error'); return; }
      btn.disabled = true;
      // Ending before the start time means the work ran past midnight; it is recorded on the start date.
      if (await saveEntry({ date: m.date, seconds: s, projectId: draft.projectId, personId: pid, task: draft.task })) {
        draft.task = ''; draft.projectId = null; m.start = m.end; m.end = null;
        await refresh();
      } else btn.disabled = false;
    }
    replace(root, h('div', { class: 'tt-row' }, task, h('div', { class: 'tt-cell' }, picker.el), person ? h('div', { class: 'tt-cell' }, person) : null,
      h('div', { class: 'tt-cell tt-times' }, startIn, h('span', { class: 'muted', 'aria-hidden': 'true' }, '–'), endIn),
      h('div', { class: 'tt-cell tt-date-cell' }, dateBtn, dateIn),
      h('div', { class: 'tt-cell tt-cell-clock' }, dur), btn, modeToggle()));
  }

  function render() {
    clearInterval(tick);
    if (!people().length) { replace(root, h('p', { class: 'muted tt-note' }, 'Add an employee under Employees & Rates to start tracking time.')); return; }
    if (mode === 'manual') renderManual(); else renderTimer();
  }
  // Another tab started or stopped the timer: redraw from the stored state.
  const sync = setInterval(() => {
    if (!root.isConnected) { clearInterval(sync); return; }
    const now = JSON.stringify(load(TIMER_KEY));
    if (now !== lastTimer) { lastTimer = now; if (!root.contains(document.activeElement)) render(); }
  }, 1500);
  render();
  return root;
}
