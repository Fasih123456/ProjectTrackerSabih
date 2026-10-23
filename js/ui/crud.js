// Generic list screen + modal editor with explicit Submit / Cancel.
import { h, replace, openDialog, confirmDialog, alertDialog, choiceDialog, toast, icon } from './dom.js';
import { dataTable, formatCell } from './table.js';
import { createForm } from './fields.js';
import { app, clientOptions, projectOptions, personOptions, salespersonOptions, contractOptions } from './state.js';
import { STORES, blankRecord } from '../model/schema.js';
import { validateRecord, ctxFromDataset } from '../model/validate.js';
import { findDependents } from '../storage/db.js';
import { inRange } from '../lib/dates.js';
import { toCSV } from '../io/csv.js';
import { downloadText, stampForFile } from '../io/download.js';

const listState = {}; // per-store filters, kept across refreshes

// A summary card: { label, value, unit, sub, subTone, pill, icon, tone, highlight } (tone picks the icon colour;
// highlight: 'pos' | 'neg' frames the card as the headline figure).
export function statCard(k) {
  return h('div', { class: `stat-card${k.highlight ? ' stat-hl stat-hl-' + k.highlight : ''}` },
    h('div', { class: 'stat-body' },
      h('div', { class: 'stat-label' }, k.label),
      h('div', { class: 'stat-value-row' }, h('span', { class: `stat-value${k.valueTone ? ' ' + k.valueTone : ''}` }, k.value), k.unit ? h('span', { class: 'stat-unit' }, k.unit) : null, k.pill ? h('span', { class: 'pill pill-green' }, k.pill) : null),
      k.sub ? h('div', { class: `stat-sub${k.subTone ? ' ' + k.subTone : ''}` }, k.sub) : null),
    k.icon ? h('div', { class: `stat-icon tone-${k.tone || 'teal'}`, 'aria-hidden': 'true' }, icon[k.icon]()) : null);
}

function filterBar(cfg, st, onChange, trailing = null) {
  const items = [];
  const sel = (label, key, options) => {
    const s = h('select', { 'aria-label': label, onchange: () => { st[key] = s.value === '' ? null : (isNaN(+s.value) ? s.value : +s.value); onChange(); } },
      h('option', { value: '' }, `All ${label.toLowerCase()}`), options.map((o) => h('option', { value: String(o.value) }, o.label)));
    s.value = st[key] ?? '';
    return h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label), s);
  };
  const search = h('input', { type: 'search', placeholder: 'Search…', 'aria-label': 'Search records', value: st.q || '', oninput: () => { st.q = search.value; onChange(); } });
  items.push(h('label', { class: 'filter filter-search' }, h('span', { class: 'filter-label' }, 'Search'), h('span', { class: 'input-icon' }, icon.search(), search)));
  for (const f of cfg.filters || []) {
    if (f === 'client') items.push(sel('Client', 'clientId', clientOptions()));
    else if (f === 'project') items.push(sel('Project', 'projectId', projectOptions()));
    else if (f === 'person') items.push(sel('Employee', 'personId', personOptions()));
    else if (f === 'salesperson') items.push(sel('Salesperson', 'spId', salespersonOptions()));
    else if (f === 'contract') items.push(sel('Contract', 'contractId', contractOptions()));
    else if (f.startsWith('type:')) items.push(sel('Type', 'type', f.slice(5).split('|').map((v) => ({ value: v, label: v }))));
    else if (f.startsWith('status:')) items.push(sel('Status', 'status', f.slice(7).split('|').map((v) => ({ value: v, label: v }))));
    else if (f === 'date') {
      const mk = (key, label) => { const i = h('input', { type: 'date', 'aria-label': `${label} (${cfg.dateLabel})`, value: st[key] || '', onchange: () => { st[key] = i.value || null; onChange(); } }); return h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, `${label} (${cfg.dateLabel})`), i); };
      items.push(mk('from', 'From'), mk('to', 'To'));
    }
  }
  if (cfg.archivable) {
    const cb = h('input', { type: 'checkbox', checked: !!st.archived, onchange: () => { st.archived = cb.checked; onChange(); } });
    items.push(h('label', { class: 'filter filter-check' }, cb, ` ${cfg.archivedLabel || 'Show archived'}`));
  }
  return h('div', { class: 'filters', role: 'search' }, items, trailing);
}

function applyFilters(cfg, rows, st) {
  const cols = cfg.columns();
  const q = (st.q || '').trim().toLowerCase();
  return rows.filter((r) => {
    if (cfg.archivable && !st.archived && (cfg.isHidden ? cfg.isHidden(r) : r._rec.Archived)) return false;
    if (st.contractId && r.contractId !== st.contractId) return false;
    if (st.status && r.statusKey !== st.status) return false;
    if (st.clientId && r.clientId !== st.clientId) return false;
    if (st.projectId && r.projectId !== st.projectId) return false;
    if (st.personId && r.personId !== st.personId) return false;
    if (st.spId && r.spId !== st.spId) return false;
    if (st.type && r.type !== st.type) return false;
    if ((st.from || st.to) && !inRange(r.date, st.from, st.to)) return false;
    if (q) { const text = cols.map((c) => formatCell(c.type, c.value ? c.value(r) : r[c.key])).join(' ').toLowerCase(); if (!text.includes(q)) return false; }
    return true;
  });
}

export function renderList(container, cfg, params = {}) {
  const st = (listState[cfg.store] ||= {});
  if (params.contract) st.contractId = Number(params.contract); // e.g. #/clauses?contract=3 from a contract's row
  if (params.salesperson) { for (const k of Object.keys(st)) delete st[k]; st.spId = Number(params.salesperson); } // e.g. #/activities?salesperson=2 from the Salespeople list: all of their records
  const def = STORES[cfg.store];
  const tableHost = h('div', {});
  const countEl = h('span', { 'aria-live': 'polite' });
  const footEl = h('span', {});
  // cfg.kpis(rows) -> summary cards above the list; cfg.filterSummary(rows) -> totals line under the filters. Both follow the filters.
  const kpiHost = cfg.kpis ? h('section', { class: 'stat-cards', 'aria-label': `${cfg.title} summary` }) : null;
  const summaryHost = cfg.filterSummary ? h('div', { class: 'filter-summary' }) : null;
  const table = (rows, { title = null, empty = null } = {}) => dataTable({
    columns: cfg.columns(), rows, totals: cfg.totals ? cfg.totals(rows) : null, caption: title || cfg.title, idOf: (r) => r._rec[def.key],
    empty: empty || (cfg.rows().length ? 'No records match the current search/filters.' : (cfg.emptyText || `No ${def.label.toLowerCase()} yet. Use “${cfg.addLabel || 'Add'}” to create the first one.`)),
    onOpen: (r) => openEditor(cfg, r._rec),
    actions: (r) => [
      cfg.rowActions ? cfg.rowActions(r) : null,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => openEditor(cfg, r._rec), 'aria-label': `Edit ${cfg.describe(r._rec)}` }, icon.edit(), ' Edit'),
      cfg.archivable ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => toggleArchive(cfg, r._rec), 'aria-label': `${r._rec.Archived ? 'Unarchive' : 'Archive'} ${cfg.describe(r._rec)}` }, icon.archive(), r._rec.Archived ? ' Unarchive' : ' Archive') : null,
      h('button', { type: 'button', class: 'btn btn-small btn-danger-ghost', onclick: () => deleteRecord(cfg, r._rec), 'aria-label': `Delete ${cfg.describe(r._rec)}` }, icon.trash(), ' Delete'),
    ],
  });
  // cfg.chart adds a chart above the list; it gets the filtered rows minus the date range (it navigates dates itself).
  const chart = cfg.chart ? cfg.chart() : null;
  const draw = () => {
    const all = cfg.rows();
    const rows = applyFilters(cfg, all, st);
    const derivedRows = cfg.derived ? applyFilters(cfg, cfg.derived.rows(), st) : null;
    if (kpiHost) replace(kpiHost, cfg.kpis(rows, all, { derived: derivedRows, filters: st }).map(statCard));
    if (summaryHost) replace(summaryHost, cfg.filterSummary(rows));
    footEl.textContent = `Displaying ${rows.length} of ${all.length} ${rows.length === 1 && all.length === 1 ? def.singular : def.label.toLowerCase()}`;
    chart?.update(applyFilters(cfg, cfg.rows(), { ...st, from: null, to: null }), st);
    countEl.textContent = `${rows.length} record${rows.length === 1 ? '' : 's'}`;
    // cfg.sections splits one store into several tables (e.g. recurring income vs costs), each with its own totals.
    if (cfg.sections) {
      replace(tableHost, cfg.summary ? cfg.summary(rows) : null, cfg.sections.map((s) => {
        const part = rows.filter(s.filter);
        return h('section', { class: 'list-section' },
          h('div', { class: 'section-head' }, h('h2', {}, s.title), h('span', { class: 'section-count' }, `${part.length} ${s.unit || 'rule'}${part.length === 1 ? '' : 's'}`)),
          table(part, { title: s.title, empty: s.empty }));
      }));
    } else if (cfg.listView) { // a custom list layout instead of the table (e.g. time entries grouped by day)
      replace(tableHost, cfg.listView(rows, {
        open: (r) => openEditor(cfg, r._rec), remove: (r) => deleteRecord(cfg, r._rec), describe: (r) => cfg.describe(r._rec),
        colorOf: (id) => chart?.colorOf?.(id) ?? '#9aa7ac',
        empty: cfg.rows().length ? 'No records match the current search/filters.' : `No ${def.label.toLowerCase()} yet. Use “${cfg.addLabel || 'Add'}” to create the first one.`,
      }));
    } else replace(tableHost, table(rows));
    // cfg.derived adds a read-only table of figures computed elsewhere (e.g. sales commission on the costs screen),
    // in its own card below the list; d.columns may narrow the columns, d.subtotal(rows) goes in the card header.
    if (derivedHost) {
      const d = cfg.derived, part = derivedRows;
      const open = (r) => { location.hash = `#/${r._link.store}?edit=${r._link.id}`; };
      replace(derivedHost,
        h('section', { class: 'card derived-card' },
          h('div', { class: 'derived-head' },
            h('div', {}, h('div', { class: 'section-head' }, h('h2', {}, d.title), h('span', { class: 'section-count' }, `${part.length} line${part.length === 1 ? '' : 's'}`)),
              d.note ? h('p', { class: 'muted small' }, d.note) : null),
            d.subtotal ? h('div', { class: 'derived-subtotal' }, d.subtotal(part)) : null),
          dataTable({
            columns: d.columns ? d.columns() : cfg.columns(), rows: part, totals: d.columns ? null : cfg.totals ? cfg.totals(part) : null, caption: d.title, empty: d.empty,
            onOpen: open,
            actions: (r) => [h('button', { type: 'button', class: 'btn btn-small btn-link-teal', onclick: () => open(r), 'aria-label': `Open source of ${r.item}` }, icon.external(), ` Open ${r._link.label}`)],
          })),
        d.summary ? d.summary(rows, part) : null);
    }
  };
  const derivedHost = cfg.derived ? h('div', { class: 'derived-host' }) : null;
  const exportCsv = () => {
    const rows = applyFilters(cfg, cfg.rows(), st);
    const cols = [{ key: '_id', label: def.key, type: 'int', value: (r) => r._rec[def.key] }, ...(cfg.csvColumns ? cfg.csvColumns() : cfg.columns())];
    downloadText(`${cfg.store}_${stampForFile()}.csv`, toCSV(cols, rows, { totals: cfg.totals ? cfg.totals(rows) : null }), 'text/csv');
  };
  app.exportCurrent = exportCsv; // header "Export" button
  replace(container,
    h('div', { class: 'page-head' },
      h('div', {}, h('div', { class: 'title-row' }, h('h1', {}, cfg.title), cfg.badge ? h('span', { class: 'title-badge' }, cfg.badge) : null), h('p', { class: 'lead' }, cfg.description)),
      h('div', { class: 'page-actions' },
        h('button', { type: 'button', class: 'btn', onclick: exportCsv }, icon.download(), ' Export CSV'),
        cfg.hideAdd ? null : h('button', { type: 'button', class: 'btn btn-primary', onclick: () => openEditor(cfg, null) }, icon.plus(), ' ', cfg.addLabel || 'Add'))),
    cfg.intro ? cfg.intro() : null,
    kpiHost,
    chart?.el,
    h('section', { class: 'card filter-card no-print' }, filterBar(cfg, st, draw, h('span', { class: 'count-badge' }, h('span', { class: 'count-dot', 'aria-hidden': 'true' }), countEl)), summaryHost),
    h('section', { class: `card list-card${cfg.sections ? ' list-card-sections' : ''}` }, tableHost, h('div', { class: 'list-foot' }, footEl)),
    derivedHost);
  draw();
  if (params.edit) { const rec = app.ds[cfg.store].find((r) => r[def.key] === Number(params.edit)); if (rec) openEditor(cfg, rec); else toast(`${def.singular} #${params.edit} not found`, 'error'); }
  else if (params.new) openEditor(cfg, null);
}

export function openEditor(cfg, existing) {
  const def = STORES[cfg.store];
  if (app.editor) return;
  const base = existing ? { ...existing } : { ...blankRecord(cfg.store), ...(cfg.defaults ? cfg.defaults(listState[cfg.store] || {}) : {}) }; // defaults may use the list's filters
  cfg.initial?.(base, existing); // values of form-only fields kept in another store (e.g. a client's acquisition)
  const banner = h('div', { class: 'form-banner', role: 'alert', hidden: true });
  const previewBox = h('div', { class: 'preview', 'aria-live': 'polite' });
  const updatePreview = () => { if (!cfg.preview) return; const { values } = form.values(); replace(previewBox, cfg.preview({ ...base, ...values }, existing)); };
  const form = createForm(cfg.formFields(existing), base, { onChange: (f, name) => { cfg.onChange?.(f, name, existing); updatePreview(); } });
  cfg.onInit?.(form, existing); // e.g. fill calculated read-only fields for the opened record
  // cfg.formExtra(existing) -> { el, isDirty(), commit(saved) }: a section kept outside the form fields (attachments),
  // applied after the record itself is saved.
  const extra = cfg.formExtra ? cfg.formExtra(existing) : null;
  const isDirty = () => form.isDirty() || !!extra?.isDirty();
  const commitExtra = async (saved) => {
    if (!extra) return;
    try { await extra.commit(saved); } catch (e) { toast('The record was saved, but the files could not be stored: ' + (e.message || e), 'error', 9000); }
  };
  const showBanner = (msg, kind = 'error', extra = null) => { replace(banner, h('strong', {}, kind === 'error' ? 'Not saved. ' : ''), msg, extra); banner.className = `form-banner form-banner-${kind}`; banner.hidden = false; };
  const submitBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Submit');
  // cfg.saveModes(existing): alternative save buttons [{ label, title, opts, kind }] passed to db.update as options
  // (e.g. a recurring rule: keep or update the entries it already created). They replace the single Submit button.
  const modes = existing && cfg.saveModes ? cfg.saveModes(existing) : null;
  const modeBtns = (modes || []).map((m) => h('button', { type: 'button', class: `btn btn-${m.kind || 'primary'}`, title: m.title || null, onclick: () => submit(m.opts) }, m.label));
  const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: () => requestCancel() }, 'Cancel');
  const formEl = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit(); } }, banner, cfg.formIntro ? cfg.formIntro(existing) : null, form.el, extra?.el, previewBox);
  const d = openDialog({
    title: existing ? `Edit ${def.singular}` : `Add ${def.singular}`,
    body: formEl, wide: cfg.wideForm,
    footer: [h('span', { class: 'muted small foot-note' }, modes ? 'Nothing is saved until you choose how to save.' : 'Nothing is saved until you press Submit.'), cancelBtn, ...(modes ? modeBtns : [submitBtn])],
    onCancelRequest: () => { requestCancel(); return false; },
  });
  submitBtn.type = 'button'; submitBtn.onclick = () => submit(); // footer sits outside the <form>; only the Submit button saves
  updatePreview();
  setTimeout(() => form.focusFirst(), 0);

  let closed = false;
  const close = () => { closed = true; app.editor = null; d.close(); };
  app.editor = {
    isDirty: () => !closed && isDirty(),
    discard: () => close(),
    externalChange: () => {
      if (!existing) { form.refreshOptions(); return; }
      const now = app.ds[cfg.store].find((r) => r[def.key] === existing[def.key]);
      if (!now) showBanner('This record was deleted in another tab or window. Cancel to close this editor.', 'warning');
      else if (now.revision !== existing.revision) showBanner('This record was changed in another tab or window. Your Submit will be refused to avoid overwriting it — Cancel and reopen to see the latest version.', 'warning');
    },
  };

  async function requestCancel() {
    if (isDirty() && !(await confirmDialog('Discard your unsaved changes? Nothing will be saved.', { title: 'Discard changes?', ok: 'Discard changes', cancel: 'Keep editing', danger: true }))) return;
    close();
    app.render();
  }

  async function submit(saveOpts = {}) {
    banner.hidden = true;
    const { values, errors } = form.values();
    if (Object.keys(errors).length) { form.setErrors(errors); return; }
    const candidate = { ...base, ...values };
    cfg.prepare?.(candidate, existing); // derived fields (time entries: billed = worked; income/costs: base-currency amount from the currency)
    const errs = { ...validateRecord(cfg.store, candidate, ctxFromDataset(app.ds), existing), ...(cfg.validate?.(candidate, existing) || {}) };
    if (Object.keys(errs).length) { form.setErrors(errs); return; }
    form.setErrors({});
    if (cfg.beforeSubmit && !(await cfg.beforeSubmit(candidate, existing))) return;
    const busy = (on) => { for (const b of [submitBtn, ...modeBtns]) b.disabled = on; cancelBtn.disabled = on; };
    const label = submitBtn.textContent; busy(true); submitBtn.textContent = 'Saving…';
    try {
      // cfg.expand turns one entry into several records (e.g. a cost split across projects), saved all-or-nothing.
      // When editing, the first record replaces the one being edited and the rest are added.
      const many = cfg.expand ? cfg.expand(candidate, existing) : null;
      if (many && many.length > 1) {
        const saved = existing ? await app.db.updateAndCreate(cfg.store, many[0], existing.revision, many.slice(1)) : await app.db.createMany(cfg.store, many);
        close();
        await commitExtra(saved[0]); // files go with the first (main) record
        await app.reload();
        app.render();
        toast(`${saved.length} ${def.label.toLowerCase()} records saved (#${saved.map((r) => r[def.key]).join(', #')}).`);
        return;
      }
      const saved = existing ? await app.db.update(cfg.store, candidate, existing.revision, saveOpts) : await app.db.create(cfg.store, candidate);
      close();
      await commitExtra(saved);
      if (cfg.afterSave) { try { await cfg.afterSave(saved, candidate, existing); } catch (e) { toast('Saved, but follow-up processing failed: ' + e.message, 'error', 8000); } }
      await app.reload();
      app.render();
      toast(`${def.singular[0].toUpperCase() + def.singular.slice(1)} saved (#${saved[def.key]}).`);
    } catch (e) {
      if (e.name === 'ValidationError') form.setErrors(e.fields);
      else showBanner(e.message || String(e));
    } finally {
      if (!closed) { busy(false); submitBtn.textContent = label; }
    }
  }
}

async function toggleArchive(cfg, rec) {
  const def = STORES[cfg.store];
  try {
    await app.db.update(cfg.store, { ...rec, Archived: rec.Archived ? null : true }, rec.revision);
    await app.reload(); app.render();
    toast(`${cfg.describe(rec)} ${rec.Archived ? 'restored to selectors' : 'archived (hidden from selectors; history and reports unchanged)'}.`);
  } catch (e) { alertDialog(e.message, { title: `Could not update ${def.singular}` }); }
}

export async function deleteRecord(cfg, rec) {
  const def = STORES[cfg.store];
  const id = rec[def.key];
  const deps = findDependents(app.ds, cfg.store, id);
  if (deps.length) {
    const list = h('ul', {}, deps.map((d) => h('li', {}, `${d.count} ${STORES[d.store].label.toLowerCase()} record${d.count === 1 ? '' : 's'} (IDs ${d.ids.slice(0, 12).join(', ')}${d.ids.length > 12 ? '…' : ''})`)));
    const msg = `“${cfg.describe(rec)}” cannot be deleted because other records depend on it. Financial history is never deleted automatically.`;
    if (cfg.archivable && !rec.Archived) {
      if (await confirmDialog(msg, { title: 'Cannot delete', details: h('div', {}, list, h('p', {}, 'You can archive it instead: it stays in all reports but is hidden from selectors.')), ok: 'Archive instead', cancel: 'Close' })) toggleArchive(cfg, rec);
    } else alertDialog(msg, { title: 'Cannot delete', details: list });
    return;
  }
  // cfg.deleteChoices(rec): { message, details, choices: [{ label, value: removeOpts, kind }], done(removed, opts) } when the
  // delete can go several ways (e.g. a recurring rule with or without its entries); null for a plain confirmation.
  const choice = cfg.deleteChoices ? cfg.deleteChoices(rec) : null;
  let removeOpts = {};
  if (choice) {
    const picked = await choiceDialog(choice.message, { title: `Delete ${def.singular}?`, choices: choice.choices, details: choice.details });
    if (!picked) return;
    removeOpts = picked;
  } else if (!(await confirmDialog(`Delete ${def.singular} #${id} “${cfg.describe(rec)}”?${cfg.deleteNote ? cfg.deleteNote(rec) : ''} This cannot be undone.`, { title: `Delete ${def.singular}?`, ok: 'Delete', danger: true }))) return;
  try {
    const removed = await app.db.remove(cfg.store, id, rec.revision, removeOpts);
    await app.reload(); app.render();
    toast(choice?.done ? choice.done(removed, removeOpts) : `Deleted ${def.singular} #${id}.`);
  } catch (e) { await app.reload(); app.render(); alertDialog(e.message, { title: 'Not deleted', details: e.deps ? h('ul', {}, e.deps.map((d) => h('li', {}, `${d.count} ${STORES[d.store].label}`))) : null }); }
}
