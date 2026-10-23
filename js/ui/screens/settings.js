// Settings & Backup: storage status, backup/restore, Access import, branding, cost categories, demo mode.
import { h, replace, toast, confirmDialog, alertDialog, icon } from '../dom.js';
import { dataTable } from '../table.js';
import { app, projectOptions } from '../state.js';
import { parseCostAppend, planCostAppend } from '../../io/costAppend.js';
import { Dec } from '../../lib/decimal.js';
import { storageStatus } from '../../storage/db.js';
import { parseBackup, restoreParsed } from '../../io/backup.js';
import { parseAccessExport, importParsed } from '../../io/accessImport.js';
import { readFileText, readFileDataURL } from '../../io/download.js';
import { demoDataset, resetDataset } from '../../io/fixtures.js';
import { dataQualityIssues } from '../../calc/quality.js';
import { clientNameById } from '../../calc/calc.js';
import { sendTestNotification, refreshNotifications } from '../notifications.js';
import { STORES, STORE_NAMES, DB_VERSION, APP_VERSION, CATEGORY_BY_CODE, DB_NAME, DEMO_DB_NAME } from '../../model/schema.js';
import { fmtBytes, fmtDateTime, fmtMoney } from '../../lib/format.js';
import { exportBackupNow, applyHeaderLogo, logoSrc, DEFAULT_LOGO } from '../brand.js';

// A settings card: header bar (icon, title, optional right-hand note) above the body.
// spec is a title string or { title, icon, aside, cls }.
function section(spec, ...children) {
  const { title, icon: ico = null, aside = null, cls = '' } = typeof spec === 'string' ? { title: spec } : spec;
  return h('section', { class: `card settings-section${cls ? ' ' + cls : ''}` },
    h('div', { class: 'settings-bar' }, h('div', { class: 'settings-bar-title' }, ico ? h('span', { class: 'settings-bar-icon' }, icon[ico]()) : null, h('h2', {}, title)), aside),
    h('div', { class: 'settings-body' }, children));
}
// A file chooser with a visible label (operation cards place it at the bottom).
const filePick = (label, input) => h('label', { class: 'file-pick' }, h('span', { class: 'file-pick-label' }, label), input);

// [label, pill tone, explanation] for the browser's storage persistence.
function storageState() {
  const s = app.storage || {};
  return !s.supported ? ['Unavailable', 'neg', 'This browser does not expose the Storage API. Records are still saved in IndexedDB, but the browser may clear them under storage pressure. Export backups regularly.']
    : s.persisted ? ['Persistent', 'pos', 'The browser has granted persistent storage: it will not evict tracker data automatically. Clearing site data or deleting the browser profile still removes it.']
      : ['Best-effort', 'warn', 'Persistent storage was not granted (the browser decides this, often based on site engagement or bookmarks). Data normally stays, but the browser may clear it under severe disk pressure. Keep regular backups.'];
}

function storageBlock() {
  const s = app.storage || {};
  const state = storageState();
  const retry = h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { app.storage = await storageStatus({ request: true }); app.render(); toast(app.storage.persisted ? 'Persistent storage granted.' : 'The browser did not grant persistent storage.', app.storage.persisted ? 'ok' : 'warn'); } }, 'Request persistent storage again');
  return section({ title: 'Storage', icon: 'database', aside: h('span', { class: 'settings-bar-note mono' }, 'IndexedDB') },
    h('dl', { class: 'settings-kv' },
      h('dt', {}, 'Storage state'), h('dd', {}, h('span', { class: `pill pill-${state[1]}` }, state[0]), h('p', { class: 'settings-kv-text' }, state[2]), s.supported && !s.persisted ? retry : null),
      h('dt', {}, 'Estimated usage'), h('dd', {}, s.usage !== null && s.usage !== undefined ? [h('strong', { class: 'mono' }, fmtBytes(s.usage)), ' of about ', h('strong', { class: 'mono' }, fmtBytes(s.quota)), ' available to this site'] : 'Not reported by this browser'),
      h('dt', {}, 'Database'), h('dd', {}, h('code', {}, app.dbName), ` (IndexedDB, schema version ${DB_VERSION})`),
      h('dt', {}, 'Address (origin)'), h('dd', {}, h('code', { class: 'code-brand' }, location.origin), ' — always open the tracker at this exact address. A different browser, profile, host name or port has its own separate (empty) storage.'),
      h('dt', {}, 'Last exported backup'), h('dd', {}, app.lastBackupAt ? h('span', { class: 'settings-date' }, icon.calendar(), fmtDateTime(app.lastBackupAt)) : h('span', { class: 'pill pill-warn' }, 'No backup exported yet'))));
}

// Shared replace-all flow for backup restore and Access import.
function replaceFlow({ title, intro, accept, parse, apply, kind, icon: ico, pickLabel }) {
  const out = h('div', { class: 'replace-preview' });
  const file = h('input', { type: 'file', accept, 'aria-label': title });
  file.addEventListener('change', async () => {
    replace(out);
    const f = file.files[0];
    if (!f) return;
    let parsed;
    try { parsed = parse(await readFileText(f)); } catch (e) { parsed = { ok: false, errors: ['Could not read the file: ' + e.message], warnings: [] }; }
    if (!parsed.ok) {
      replace(out, h('div', { class: 'form-banner form-banner-error', role: 'alert' }, h('strong', {}, 'This file cannot be used. Nothing has been changed.'),
        h('ul', {}, parsed.errors.slice(0, 30).map((e) => h('li', {}, e))), parsed.errors.length > 30 ? h('p', {}, `…and ${parsed.errors.length - 30} more problems.`) : null));
      return;
    }
    const counts = STORE_NAMES.map((s) => ({ table: STORES[s].table, label: STORES[s].label, current: app.ds[s].length, incoming: parsed.counts[s] }));
    const totalIn = counts.reduce((n, c) => n + c.incoming, 0);
    const dq = kind === 'access' ? dataQualityIssues(parsed.data.stores) : [];
    const ack = h('input', { type: 'checkbox', id: 'ack-' + kind });
    const go = h('button', { type: 'button', class: 'btn btn-danger', disabled: true }, `Replace all current records (${totalIn} records)`);
    const dirty = app.editor?.isDirty?.();
    ack.addEventListener('change', () => { go.disabled = !ack.checked || !!app.editor?.isDirty?.(); });
    go.addEventListener('click', async () => {
      if (app.editor?.isDirty?.()) { alertDialog('You have unsaved edits open. Submit or cancel them first.'); return; }
      if (!(await confirmDialog(`Replace all ${counts.reduce((n, c) => n + c.current, 0)} current records in “${app.dbName}” with the ${totalIn} records from “${f.name}”? This is one all-or-nothing operation.`, { title: 'Replace all records?', ok: 'Replace all records', danger: true }))) return;
      go.disabled = true; go.textContent = 'Replacing…';
      try {
        await apply(parsed);
        await app.reload();
        applyHeaderLogo();
        app.render();
        toast(`${kind === 'access' ? 'Access data imported' : 'Backup restored'}: ${totalIn} records.`, 'ok', 6000);
      } catch (e) {
        await app.reload(); app.render();
        alertDialog(`Nothing was changed — the operation was cancelled as a whole. (${e.message})`, { title: 'Replacement failed' });
      }
    });
    replace(out,
      h('h3', {}, 'Preview — nothing has been changed yet'),
      parsed.exportedAt ? h('p', { class: 'muted' }, `File created ${parsed.exportedAt}${parsed.sourceFile ? ` from ${parsed.sourceFile}` : ''}${parsed.appVersion ? ` by tracker ${parsed.appVersion}` : ''}.`) : null,
      dataTable({ noSort: true, caption: 'Record counts', columns: [{ key: 'label', label: 'Store', type: 'text' }, { key: 'table', label: 'Access table', type: 'text' }, { key: 'current', label: 'Current records (will be removed)', type: 'int' }, { key: 'incoming', label: 'Records in file', type: 'int' }], rows: counts, totals: { label: 'Total', table: '', current: counts.reduce((n, c) => n + c.current, 0), incoming: totalIn } }),
      parsed.categoryMap?.length ? h('p', {}, 'Company cost categories assigned by exact internal project name: ', parsed.categoryMap.map((c) => `${c.ProjectName} (#${c.ProjectID}) → ${CATEGORY_BY_CODE[c.CategoryCode].name}`).join('; '), '.') : null,
      parsed.warnings.length ? h('details', {}, h('summary', {}, `${parsed.warnings.length} warning(s)`), h('ul', {}, parsed.warnings.map((w) => h('li', {}, w)))) : null,
      dq.length ? h('details', {}, h('summary', {}, `${dq.length} data-quality note(s) — imported as-is, listed later under Reports → Data Quality`), h('ul', {}, dq.slice(0, 50).map((i) => h('li', {}, `${STORES[i.store].table} #${i.id}: ${i.message}`)))) : null,
      h('div', { class: 'replace-steps' },
        h('p', {}, h('strong', {}, 'Step 1. '), 'Download a backup of the current records first: ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => exportBackupNow() }, icon.download(), ' Export current data')),
        dirty ? h('p', { class: 'note note-warning' }, 'You have unsaved edits open in another screen. Submit or cancel them before replacing data.') : null,
        h('p', { class: 'check-line' }, ack, h('label', { for: 'ack-' + kind }, h('strong', {}, 'Step 2. '), 'I understand that every current record will be replaced by the records in this file.')),
        go));
  });
  return section({ title, icon: ico, cls: 'settings-op' }, h('p', { class: 'settings-text' }, intro), filePick(pickLabel, file), out);
}

// Append-only cost import: keeps every existing record, maps costs to existing projects by name.
function costAppendBlock() {
  const out = h('div', { class: 'replace-preview' });
  const file = h('input', { type: 'file', accept: '.json,application/json', 'aria-label': 'Choose cost file' });
  file.addEventListener('change', async () => {
    replace(out);
    const f = file.files[0];
    if (!f) return;
    let parsed;
    try { parsed = parseCostAppend(await readFileText(f), app.ds); } catch (e) { parsed = { ok: false, errors: [e.message] }; }
    if (!parsed.ok) { replace(out, h('div', { class: 'form-banner form-banner-error', role: 'alert' }, h('strong', {}, 'This file cannot be used. Nothing has been changed.'), h('ul', {}, parsed.errors.slice(0, 30).map((e) => h('li', {}, e))))); return; }
    const selects = new Map();
    const summary = h('div', {});
    const go = h('button', { type: 'button', class: 'btn btn-primary' }, 'Add costs');
    const refresh = () => {
      const mapping = new Map([...selects].map(([sid, s]) => [sid, s.value ? Number(s.value) : null]));
      const unmapped = [...mapping.values()].filter((v) => v === null).length;
      if (unmapped) { replace(summary, h('p', { class: 'note note-warning' }, `Choose a project for the ${unmapped} unmatched source project(s) above before adding.`)); go.disabled = true; return; }
      const plan = planCostAppend(parsed, mapping, app.ds);
      const total = Dec.sum(plan.toAdd.map((r) => r.CostAmount));
      replace(summary, h('p', {}, h('strong', {}, `${plan.toAdd.length} cost(s) will be added`), ` (total ${fmtMoney(total)}).`,
        plan.duplicates.length ? ` ${plan.duplicates.length} identical cost(s) already exist and will be skipped.` : ''));
      go.disabled = plan.toAdd.length === 0;
      go.onclick = async () => {
        if (app.editor?.isDirty?.()) { alertDialog('You have unsaved edits open. Submit or cancel them first.'); return; }
        if (!(await confirmDialog(`Add ${plan.toAdd.length} costs (${fmtMoney(total)}) to your existing records? Nothing existing is changed or removed.`, { title: 'Add costs?', ok: 'Add costs' }))) return;
        go.disabled = true; go.textContent = 'Adding…';
        try {
          const created = await app.db.createMany('costs', plan.toAdd);
          await app.reload(); app.render();
          toast(`${created.length} costs added.`, 'ok', 6000);
        } catch (e) {
          await app.reload(); app.render();
          alertDialog(`Nothing was added — the whole operation was cancelled. ${e.fields ? Object.values(e.fields).join(' ') : e.message}`, { title: 'Costs not added' });
        }
      };
    };
    const rows = parsed.sources.map((s) => {
      const sel = h('select', { 'aria-label': `Target project for ${s.label}`, onchange: refresh }, h('option', { value: '' }, '— choose project —'), projectOptions().map((o) => h('option', { value: String(o.value) }, o.label)));
      sel.value = s.match ? String(s.match) : '';
      selects.set(s.sourceProjectId, sel);
      return h('tr', {}, h('td', {}, s.label), h('td', { class: 'num' }, String(s.count)), h('td', { class: 'num' }, fmtMoney(s.total)), h('td', {}, sel, s.match ? null : h('div', { class: 'field-error' }, 'No project with this client and name — choose one')));
    });
    replace(out,
      h('h3', {}, 'Preview — nothing has been added yet'),
      h('p', {}, `${parsed.rows.length} costs found. Each source project is matched to your existing project with the same client and project name. Check or change the matches:`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'data' }, h('thead', {}, h('tr', {}, h('th', {}, 'Project in file'), h('th', { class: 'num' }, 'Costs'), h('th', { class: 'num' }, 'Total'), h('th', {}, 'Add to your project'))), h('tbody', {}, rows))),
      summary, h('div', { class: 'form-actions' }, go));
    refresh();
  });
  return section({ title: 'Add costs from file', icon: 'receipt', cls: 'settings-op' },
    h('p', { class: 'settings-text' }, 'Adds project costs from an Access export file (for example ', h('code', {}, 'access-export.json'), ') to your existing records. Your clients, projects and other records are kept; costs get new IDs. Costs that already exist identically are skipped, so running it twice does not duplicate them.'),
    filePick('Select cost records file', file), out);
}

function brandingBlock() {
  const preview = h('img', { class: 'logo-preview', src: logoSrc(), alt: 'Current logo' });
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/svg+xml', 'aria-label': 'Upload logo' });
  file.addEventListener('change', async () => {
    const f = file.files[0];
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) { toast('Please choose an image smaller than 2 MB.', 'error'); return; }
    try {
      const dataUrl = await readFileDataURL(f);
      await app.db.setSetting('logo', { dataUrl, name: f.name, updatedAt: new Date().toISOString() });
      await app.reload(); applyHeaderLogo(); app.render(); toast('Logo updated. It is included in full backups.');
    } catch (e) { toast('Could not save the logo: ' + e.message, 'error'); }
  });
  const custom = !!app.settings.logo;
  return section({ title: 'Branding', icon: 'palette' },
    h('div', { class: 'brand-row' }, h('div', { class: 'logo-frame' }, preview), h('div', { class: 'brand-controls' },
      h('p', { class: 'settings-text' }, custom ? `Custom logo: ${app.settings.logo.name}` : 'Using the original Engineered Plans logo.'),
      filePick('Upload a replacement logo (PNG, JPG, WebP or SVG)', file),
      custom ? h('button', { type: 'button', class: 'btn btn-small', onclick: async () => { await app.db.setSetting('logo', null); await app.reload(); applyHeaderLogo(); app.render(); toast('Original logo restored.'); } }, 'Restore original logo') : null)));
}

function categoriesBlock() {
  const rows = app.ds.projects.filter((p) => p.ProjectType === 'Internal').map((p) => ({ _rec: p, id: p.ProjectID, client: clientNameById(app.idx, p.ClientID), name: p.ProjectName, cat: CATEGORY_BY_CODE[p.CategoryCode]?.name ?? 'Other Internal Costs', code: p.CategoryCode ?? '—' }));
  return section({ title: 'Company cost centres', icon: 'sitemap', aside: h('span', { class: 'settings-bar-note' }, 'Change a category from Projects → Edit') },
    h('p', { class: 'settings-text' }, 'Company Totals group internal costs by these stable category codes (not by name). Double-click a row to open the project.'),
    dataTable({ caption: 'Internal cost centres', columns: [{ key: 'id', label: 'ProjectID', type: 'int' }, { key: 'client', label: 'Client', type: 'text' }, { key: 'name', label: 'Project', type: 'text', strong: true }, { key: 'cat', label: 'Category', type: 'text' }, { key: 'code', label: 'Code', type: 'text', align: 'center' }], rows, onOpen: (r) => { location.hash = `#/projects?edit=${r.id}`; } }));
}

// Reset all data: deletes every record, attachment and notification of the open database in one step, leaving the
// internal setup (and, if chosen, the sample clients and projects). Settings such as the logo are kept.
function resetBlock() {
  const total = STORE_NAMES.reduce((n, s) => n + app.ds[s].length, 0);
  const ack = h('input', { type: 'checkbox', id: 'ack-reset' });
  const sample = h('input', { type: 'checkbox', id: 'reset-sample' });
  const go = h('button', { type: 'button', class: 'btn btn-danger', disabled: true }, icon.trash(), ' Reset all data');
  ack.addEventListener('change', () => { go.disabled = !ack.checked; });
  go.addEventListener('click', async () => {
    if (app.editor?.isDirty?.()) { alertDialog('You have unsaved edits open. Submit or cancel them first.'); return; }
    if (!(await confirmDialog(`Permanently delete all ${total} records in “${app.dbName}”? This cannot be undone without a backup.`, { title: 'Reset all data?', ok: 'Reset all data', danger: true }))) return;
    go.disabled = true; go.textContent = 'Resetting…';
    try {
      await app.db.replaceAll(resetDataset({ sample: sample.checked }));
      await app.db.updateNotifications(() => []);
      await refreshNotifications();
      await app.reload(); app.render();
      toast(sample.checked ? 'All data reset. Sample clients and projects added.' : 'All data reset.', 'ok', 6000);
    } catch (e) {
      await app.reload(); app.render();
      alertDialog(`Nothing was changed — the reset was cancelled as a whole. (${e.message})`, { title: 'Reset failed' });
    }
  });
  return section({ title: 'Reset all data', icon: 'trash', cls: 'settings-op' },
    h('p', { class: 'settings-text' }, 'Deletes every record in this database — clients, projects, income, costs, time, contracts, recurring rules, attachments and notifications — in one all-or-nothing step. The internal client and its six company cost centres are recreated. Settings such as the logo are kept.'),
    h('div', { class: 'replace-steps' },
      h('p', {}, h('strong', {}, 'Step 1. '), 'Download a backup of the current records first: ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => exportBackupNow() }, icon.download(), ' Export current data')),
      h('p', { class: 'check-line' }, sample, h('label', { for: 'reset-sample' }, 'Add the sample clients and projects again after the reset')),
      h('p', { class: 'check-line' }, ack, h('label', { for: 'ack-reset' }, h('strong', {}, 'Step 2. '), `I understand that all ${total} current records will be permanently deleted.`)),
      go));
}

function modeBlock() {
  const setMode = (m) => { try { if (m === 'demo') localStorage.setItem('spt.mode', 'demo'); else localStorage.removeItem('spt.mode'); } catch { /* ignore */ } location.hash = '#/settings'; location.reload(); };
  if (app.mode === 'test') return section({ title: 'Data mode', icon: 'shieldCheck', aside: h('span', { class: 'pill pill-neutral' }, 'Test database') }, h('p', {}, `Automated test database (${app.dbName}).`));
  if (app.mode === 'demo') {
    return section({ title: 'Data mode', icon: 'shieldCheck', aside: h('span', { class: 'pill pill-warn' }, 'Demo mode') },
      h('p', { class: 'settings-text' }, `You are using the separate demo database (${DEMO_DB_NAME}) with fictional records. Your real records in ${DB_NAME} are untouched.`),
      h('div', { class: 'btn-row' },
        h('button', { type: 'button', class: 'btn', onclick: async () => {
          if (!(await confirmDialog('Replace the contents of the DEMO database with the fictional demo records?', { ok: 'Load demo records' }))) return;
          await app.db.replaceAll(demoDataset(), {}); await app.reload(); app.render(); toast('Demo records loaded (demo database only).');
        } }, 'Load demo records'),
        h('button', { type: 'button', class: 'btn btn-primary', onclick: () => setMode('live') }, 'Return to my real data')));
  }
  return section({ title: 'Data mode', icon: 'shieldCheck', aside: h('span', { class: 'pill pill-brand' }, 'Live data') },
    h('p', { class: 'settings-text' }, 'You are using your real business database. Demo mode opens a completely separate database with fictional example records for practice; it never mixes with your real data.'),
    h('div', {}, h('button', { type: 'button', class: 'btn', onclick: async () => { if (await confirmDialog('Switch to the separate DEMO database? Your real data stays untouched and you can switch back at any time.', { ok: 'Open demo mode' })) setMode('demo'); } }, icon.flask(), ' Open demo mode')));
}

export function renderSettings(container) {
  const state = storageState();
  replace(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'title-row' }, h('span', { class: 'title-icon', 'aria-hidden': 'true' }, icon.sliders()), h('h1', {}, 'Settings & Backup')),
        h('p', { class: 'lead' }, 'Everything is stored locally in this browser. Nothing is sent to any server or cloud service.')),
      h('div', { class: 'page-actions' },
        h('span', { class: `pill pill-${state[1]}` }, h('span', { class: 'pill-dot', 'aria-hidden': 'true' }), `${state[0]} storage`),
        h('span', { class: 'version-chip' }, `v${APP_VERSION} · schema v${DB_VERSION}`))),
    h('div', { class: 'settings-stack' },
      storageBlock(),
      section({ title: 'Backup', icon: 'cloudDown' },
        h('p', { class: 'settings-text' }, 'A full backup is a JSON file containing every record (all stores — including recurring rules — with IDs, nulls and four-decimal amounts), settings and any custom logo. It is downloaded to your computer — the only copy that survives if browser data is cleared. Export one at least weekly and keep copies on another drive.'),
        h('p', {}, h('span', { class: 'muted' }, 'Last exported: '), h('strong', {}, fmtDateTime(app.lastBackupAt))),
        h('div', {}, h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => { await exportBackupNow(); app.render(); } }, icon.download(), ' Export full backup')),
        h('p', { class: 'muted small settings-footnote' }, 'Browsers cannot silently write files to a folder of your choice, so backups are manual downloads. The tracker reminds you when the last backup is more than 7 days old.')),
      h('div', { class: 'settings-grid settings-grid-3' },
        replaceFlow({ kind: 'backup', title: 'Restore backup', icon: 'restore', pickLabel: 'Select JSON backup file', accept: '.json,application/json', parse: parseBackup, apply: (p) => restoreParsed(app.db, p), intro: 'Choose a backup file created by “Export full backup”. The whole file is checked (format, version, field types, unique IDs and references) before anything changes. The restore then replaces all records in one all-or-nothing step.' }),
        replaceFlow({ kind: 'access', title: 'Import Access export', icon: 'fileImport', pickLabel: 'Select Access export file', accept: '.json,application/json', parse: parseAccessExport, apply: (p) => importParsed(app.db, p), intro: ['One-time migration from the old Microsoft Access tracker: choose ', h('code', {}, 'reference/access-data.json'), '. Original IDs, blank values, four-decimal amounts and dates are preserved exactly. This is separate from restoring an app backup and is never done automatically.'] }),
        costAppendBlock()),
      h('div', { class: 'settings-grid settings-grid-2' },
        brandingBlock(),
        section({ title: 'Notifications', icon: 'bell' },
          h('p', { class: 'settings-text' }, 'The bell at the top shows renewal approvals due within 2 weeks, recurring entries added, recurring rules that have ended, and the year-end reminder on 24 January.'),
          h('div', {}, h('button', { type: 'button', class: 'btn', onclick: async () => { await sendTestNotification(); toast('Test notification sent — see the bell at the top.'); } }, icon.send(), ' Send a test notification')))),
      categoriesBlock(),
      resetBlock(),
      h('div', { class: 'settings-grid settings-grid-2' },
        modeBlock(),
        section({ title: 'About', icon: 'info' },
          h('dl', { class: 'settings-about' },
            h('div', {}, h('dt', {}, 'Application version'), h('dd', { class: 'mono' }, `Engineered Plans Project Tracker ${APP_VERSION}`)),
            h('div', {}, h('dt', {}, 'Default logo'), h('dd', {}, h('code', {}, DEFAULT_LOGO))))))));
}
