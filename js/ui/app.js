// Application shell: database selection/opening, navigation with unsaved-edit guard, cross-tab refresh.
import { h, replace, confirmDialog, toast, icon } from './dom.js';
import { app } from './state.js';
import { TrackerDB, storageStatus } from '../storage/db.js';
import { DB_NAME, DEMO_DB_NAME } from '../model/schema.js';
import { renderList } from './crud.js';
import { CONFIGS } from './screens/records.js';
import { renderDashboard } from './screens/dashboard.js';
import { renderBank } from './screens/bank.js';
import { renderReports, setPageOrientation } from './screens/reports.js';
import { renderSettings } from './screens/settings.js';
import { applyHeaderLogo, exportBackupNow } from './brand.js';
import { fmtDateTime, fmtMoney } from '../lib/format.js';
import { companyTotals } from '../calc/calc.js';
import { initNotifications, syncNotifications, notifyRecurringCreated, refreshNotifications } from './notifications.js';
import { todayISO } from '../lib/dates.js';
import { loadCachedLatest, syncFx } from '../io/fxRates.js';
import { renderCurrencies } from './screens/currencies.js';
import { seedStarterData } from '../io/fixtures.js';

const ROUTES = [
  { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', render: (el) => renderDashboard(el) },
  { id: 'clients', label: 'Clients', icon: 'clients', group: 'Clients', count: () => app.ds?.clients.filter((c) => !c.IsInternal && !c.Archived).length },
  { id: 'contracts', label: 'Contracts', icon: 'contract', group: 'Clients', sub: true },
  { id: 'clauses', label: 'Contract Clauses', icon: 'gavel', group: 'Clients', sub: true },
  { id: 'acquisitions', label: 'Client Acquisitions', icon: 'personAdd', group: 'Clients', sub: true },
  { id: 'sources', label: 'Acquisition Sources', icon: 'tag', group: 'Clients', sub: true },
  { id: 'projects', label: 'Projects', icon: 'folder', group: 'Records' },
  { id: 'ledger', label: 'Ledger', icon: 'book', group: 'Records', render: (el, p) => renderReports(el, p, 'ledger', { standalone: true }) },
  { id: 'income', label: 'Project Income', icon: 'payments', group: 'Records' },
  { id: 'timeEntries', label: 'Time Entries', icon: 'clock', group: 'Records' },
  { id: 'costs', label: 'Project Costs', icon: 'receipt', group: 'Records' },
  { id: 'recurring', label: 'Recurring', icon: 'sync', group: 'Records' },
  { id: 'people', label: 'Employees & Rates', icon: 'badge', group: 'Employees' },
  { id: 'salespeople', label: 'Salespeople', icon: 'headset', group: 'Employees' },
  { id: 'activities', label: 'Employee Activities', icon: 'history', group: 'Employees' },
  { id: 'payouts', label: 'Sales Payouts', icon: 'register', group: 'Employees' },
  { id: 'bank', label: 'Employee Bank Details', icon: 'bank', group: 'Confidential', render: (el, p) => renderBank(el, p) },
  { id: 'reports', label: 'Reports', icon: 'analytics', group: 'Admin', render: (el, p, sub) => renderReports(el, p, sub) },
  { id: 'currencies', label: 'Currencies', icon: 'money', group: 'Admin', render: (el) => renderCurrencies(el) },
  { id: 'settings', label: 'Settings & Backup', icon: 'restore', group: 'Admin', render: (el) => renderSettings(el) },
];
const ROUTE_BY_ID = Object.fromEntries(ROUTES.map((r) => [r.id, r]));

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const [id, sub = null] = path.split('/');
  return { id: ROUTE_BY_ID[id] ? id : 'dashboard', sub, params: Object.fromEntries(new URLSearchParams(query)) };
}

function chooseDatabase() {
  const q = new URLSearchParams(location.search);
  const t = q.get('db');
  if (t && /^engineeredplans_test_[a-z0-9_]+$/i.test(t)) return { name: t, mode: 'test' };
  let demo = false;
  try { demo = localStorage.getItem('spt.mode') === 'demo'; } catch { /* storage blocked */ }
  return demo ? { name: DEMO_DB_NAME, mode: 'demo' } : { name: DB_NAME, mode: 'live' };
}

function buildNav() {
  const sel = document.getElementById('goto');
  const groups = {};
  replace(sel, ROUTES.map((r) => {
    if (!r.group) return h('option', { value: r.id }, r.label);
    if (!groups[r.group]) { groups[r.group] = h('optgroup', { label: r.group }); return groups[r.group]; }
    return null;
  }));
  for (const r of ROUTES) if (r.group) groups[r.group].append(h('option', { value: r.id }, r.sub ? `  ↳ ${r.label}` : r.label));
  sel.addEventListener('change', () => { location.hash = '#/' + sel.value; });
  // Side menu: grouped links with icons; sub-items (contracts, clauses, acquisitions, sources) are indented under the item above them.
  const link = (r) => h('a', { href: '#/' + r.id, class: `nav-link${r.sub ? ' nav-link-sub' : ''}`, dataset: { route: r.id } },
    h('span', { class: 'nav-ico' }, icon[r.icon]()), h('span', { class: 'nav-label' }, r.label),
    r.count ? h('span', { class: 'nav-count', dataset: { count: r.id }, hidden: true }) : null);
  let lastGroup = null;
  const items = [];
  for (const r of ROUTES) {
    if (r.group && r.group !== lastGroup) { items.push(h('li', { class: 'nav-group', 'aria-hidden': 'true' }, r.group)); lastGroup = r.group; }
    items.push(h('li', {}, link(r)));
  }
  replace(document.getElementById('sidenav'), h('ul', {}, items));
  replace(document.getElementById('sidefoot'), h('ul', {},
    h('li', {}, h('a', { href: 'README.md', target: '_blank', rel: 'noopener', class: 'nav-link', title: 'Opens the user guide (README) in a new tab' }, h('span', { class: 'nav-ico' }, icon.help()), h('span', { class: 'nav-label' }, 'Documentation')))));
  replace(document.getElementById('export-btn'), icon.download(), h('span', {}, 'Export'));
  replace(document.getElementById('backup-btn'), icon.upload(), h('span', {}, 'Backup'));
  replace(document.getElementById('brand-mark'), h('img', { src: 'assets/mark.png', alt: '' }));
}

function updateNav(id) {
  document.getElementById('goto').value = id;
  for (const a of document.querySelectorAll('.sidebar a[data-route]')) { if (a.dataset.route === id) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
  for (const el of document.querySelectorAll('.nav-count')) {
    const n = ROUTE_BY_ID[el.dataset.count].count();
    el.textContent = n ?? ''; el.hidden = !n;
  }
}

// Header "Export": downloads the current screen's figures as CSV when the screen offers it (app.exportCurrent).
function updateExport() {
  const btn = document.getElementById('export-btn');
  btn.disabled = !app.exportCurrent;
  btn.title = app.exportCurrent ? 'Download this screen’s figures as a CSV file' : 'This screen has nothing to export';
}

function updateBanners() {
  const host = document.getElementById('banners');
  const items = [];
  if (app.mode === 'demo') items.push(h('div', { class: 'banner banner-demo' }, h('strong', {}, 'DEMO MODE — '), 'fictional records in a separate database. Your real data is not shown or changed. ', h('a', { href: '#/settings' }, 'Return to real data')));
  if (app.mode === 'test') items.push(h('div', { class: 'banner banner-demo' }, h('strong', {}, 'TEST DATABASE — '), app.dbName));
  if (app.storage && !app.storage.supported) items.push(h('div', { class: 'banner banner-warn' }, 'This browser does not report storage persistence. Export backups regularly.'));
  const hasRecords = app.ds && (app.ds.income.length + app.ds.costs.length + app.ds.timeEntries.length + app.ds.people.length + app.ds.activities.length + app.ds.payouts.length) > 0;
  let snoozed = false;
  try { snoozed = Number(localStorage.getItem('spt.backupSnooze') || 0) > Date.now(); } catch { /* ignore */ }
  const stale = !app.lastBackupAt || Date.now() - new Date(app.lastBackupAt).getTime() > 7 * 86400000;
  if (hasRecords && stale && !snoozed && app.mode !== 'test') {
    items.push(h('div', { class: 'banner banner-warn no-print', role: 'status' },
      h('strong', {}, 'Backup reminder: '), app.lastBackupAt ? `last backup ${fmtDateTime(app.lastBackupAt)} (over a week ago). ` : 'no backup has been exported yet. ',
      h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: async () => { await exportBackupNow(); updateBanners(); } }, 'Export backup now'), ' ',
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => { try { localStorage.setItem('spt.backupSnooze', String(Date.now() + 86400000)); } catch { /* ignore */ } updateBanners(); } }, 'Remind me tomorrow')));
  }
  replace(host, items);
  updateHeaderResult();
}

// Header box: all-time net result before owner salary (same figure as the dashboard KPI).
function updateHeaderResult() {
  const el = document.getElementById('header-result');
  if (!app.idx) { el.hidden = true; return; }
  const v = companyTotals(app.idx).beforeOwner;
  replace(el, icon.wallet(), h('span', { class: 'sr-only' }, 'Net before owner salary: '), h('span', { class: `header-result-value${v.round(2).sign() < 0 ? ' neg' : ''}` }, fmtMoney(v)));
  el.hidden = false;
}

let current = null;
function renderView() {
  const { id, sub, params } = parseHash();
  const view = document.getElementById('view');
  if (app.editor?.page) app.editor = null; // page-level editors (bank details) are rebuilt with the view
  updateNav(id);
  if (id !== 'reports') setPageOrientation('portrait');
  const r = ROUTE_BY_ID[id];
  app.exportCurrent = null; // set again by screens that can export
  try {
    if (r.render) r.render(view, params, sub);
    else renderList(view, CONFIGS[id], params);
  } catch (e) {
    console.error(e);
    replace(view, h('div', { class: 'form-banner form-banner-error' }, 'This screen could not be displayed: ' + e.message));
  }
  updateExport();
  document.title = `${r.label} — Engineered Plans Project Tracker${app.mode === 'demo' ? ' (DEMO)' : ''}`;
  updateBanners();
}

function renderCurrent() {
  // Re-render without losing the open-record query (edit/new params are one-shot).
  const hash = location.hash.replace(/\?(edit|new)=[^&]*/, '');
  if (hash !== location.hash) { history.replaceState(null, '', location.pathname + location.search + hash); current = hash; } // replaceState never fires hashchange
  renderView();
}

async function onHashChange() {
  if (app.editor?.isDirty()) {
    const target = location.hash;
    history.replaceState(null, '', location.pathname + location.search + current);
    if (!(await confirmDialog('You have unsaved changes. Leave this screen and discard them? Nothing will be saved.', { title: 'Unsaved changes', ok: 'Discard and leave', cancel: 'Stay here', danger: true }))) { updateNav(parseHash().id); return; }
    app.editor.discard();
    app.editor = null;
    for (const d of document.querySelectorAll('dialog')) { d.close(); d.remove(); }
    current = target;
    history.replaceState(null, '', location.pathname + location.search + target);
    renderView();
    return;
  }
  if (app.editor && !app.editor.page) { app.editor.discard(); for (const d of document.querySelectorAll('dialog')) { d.close(); d.remove(); } }
  current = location.hash;
  renderView();
}

async function boot() {
  const { name, mode } = chooseDatabase();
  app.dbName = name; app.mode = mode;
  document.body.classList.toggle('mode-demo', mode === 'demo');
  buildNav();
  const view = document.getElementById('view');
  try {
    app.db = await TrackerDB.open(name, {
      onBlocked: () => replace(document.getElementById('banners'), h('div', { class: 'banner banner-warn' }, 'The tracker is waiting for another open tab (running an older version) to close so it can finish upgrading the database. Close the other tracker tabs.')),
      onVersionChange: () => {
        replace(document.getElementById('banners'), h('div', { class: 'banner banner-error', role: 'alert' }, 'The tracker was upgraded in another tab. This tab has been disconnected to protect your data. ', h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => location.reload() }, 'Reload now')));
        for (const b of document.querySelectorAll('#view button, #view input, #view select, dialog button')) b.disabled = true;
      },
    });
  } catch (e) {
    replace(view, h('section', { class: 'card' }, h('h1', {}, 'The database could not be opened'), h('p', {}, e.message), h('p', {}, 'No data has been changed or deleted. Check that you are using a normal (not private) browser window, then reload. If the problem continues, keep this browser profile as it is and contact support.'), h('button', { class: 'btn btn-primary', onclick: () => location.reload() }, 'Reload')));
    return;
  }
  app.storage = await storageStatus({ request: mode !== 'test' });
  // First start of the real database: a couple of sample clients and projects (once; never over existing records).
  if (mode === 'live') { try { await seedStarterData(app.db); } catch { /* the tracker still works without them */ } }
  // Recurring rules: keep entries within the 14-day look-ahead window (at startup, after rule edits, every 30 minutes).
  app.runRecurring = async ({ render = false } = {}) => {
    try {
      const r = await app.db.generateRecurring(todayISO());
      notifyRecurringCreated(r); // bell notification per rule that got new entries
      const n = r.income + r.costs;
      if (n || r.removed) {
        const parts = [r.costs ? `${r.costs} cost${r.costs === 1 ? '' : 's'}` : '', r.income ? `${r.income} income` : ''].filter(Boolean).join(', ');
        const msgs = [];
        if (n) msgs.push(`Added ${n} recurring entr${n === 1 ? 'y' : 'ies'} (${parts}) due within the next 2 weeks.`);
        if (r.removed) msgs.push(`Removed ${r.removed} recurring entr${r.removed === 1 ? 'y' : 'ies'} more than 2 weeks ahead; ${r.removed === 1 ? 'it' : 'they'} will be added again automatically when due.`);
        toast(msgs.join(' '), 'ok', 8000);
        if (render) { await app.reload(); if (!app.editor) renderCurrent(); }
      }
      return r;
    } catch (e) { toast('Recurring entries could not be added: ' + e.message, 'error', 8000); return null; }
  };
  // Exchange rates: the newest cached day first (works offline), so recurring rules in other currencies can run.
  try { await loadCachedLatest(); } catch { /* cache unreadable: rates are downloaded below */ }
  await app.runRecurring();
  // Date-based notifications are re-checked with the recurring run, and after every save (app.reload).
  setInterval(() => { app.runRecurring({ render: true }); syncNotifications(); }, 30 * 60 * 1000);
  await app.reload();
  await initNotifications();
  app.afterReload = () => syncNotifications();
  syncNotifications();
  applyHeaderLogo();
  app.render = renderCurrent;
  // Background exchange-rate job: at start and hourly (not in test databases, which must not depend on the network).
  app.runFx = async () => {
    const r = await syncFx();
    app.fxLast = { at: new Date().toISOString(), ...r };
    if (r.refreshed) await app.runRecurring({ render: true }); // rules waiting for a first rate
    if (r.finalized) {
      await app.reload();
      if (!app.editor) renderCurrent();
      toast(`Exchange rates updated: ${r.finalized} entr${r.finalized === 1 ? 'y now uses' : 'ies now use'} the rate of ${r.finalized === 1 ? 'its' : 'their'} own date.`, 'ok', 7000);
    }
    return r;
  };
  const fxQuietly = () => app.runFx().catch((e) => { app.fxLast = { at: new Date().toISOString(), error: e.message }; });
  if (mode !== 'test') { fxQuietly(); setInterval(fxQuietly, 60 * 60 * 1000); }
  app.db.onExternalChange(async (msg) => {
    if (msg.type === 'meta' && msg.key === 'notifications') { refreshNotifications(); return; } // read/dismissed in another tab
    await app.reload();
    if (msg.type === 'settings') applyHeaderLogo();
    if (app.editor) { app.editor.externalChange?.(); updateBanners(); }
    else { renderCurrent(); toast('Updated with changes from another tab.', 'info', 2500); }
  });
  document.getElementById('export-btn').addEventListener('click', () => app.exportCurrent?.());
  document.getElementById('backup-btn').addEventListener('click', async () => { await exportBackupNow(); updateBanners(); if (parseHash().id === 'settings' && !app.editor) renderCurrent(); });
  window.addEventListener('hashchange', onHashChange);
  window.addEventListener('beforeunload', (e) => { if (app.editor?.isDirty()) { e.preventDefault(); e.returnValue = ''; } });
  current = location.hash || '#/dashboard';
  if (!location.hash) history.replaceState(null, '', location.pathname + location.search + '#/dashboard');
  renderView();
  document.body.dataset.ready = 'true';
}

boot();
