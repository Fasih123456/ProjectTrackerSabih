// Reports and query views: branded, filterable, sortable, CSV export and Print / Save as PDF.
import { h, replace, icon } from '../dom.js';
import { dataTable } from '../table.js';
import { app, clientOptions, projectOptions, personOptions, salespersonOptions } from '../state.js';
import { REPORTS, REPORT_BY_ID } from '../../reports/reports.js';
import { projectLabel, personName, salespersonName, clientLabel } from '../../calc/calc.js';
import { toCSV } from '../../io/csv.js';
import { downloadText, stampForFile } from '../../io/download.js';
import { logoSrc } from '../brand.js';

const filterState = {};

export function setPageOrientation(o = 'portrait') {
  let s = document.getElementById('page-style');
  if (!s) { s = document.createElement('style'); s.id = 'page-style'; document.head.append(s); }
  s.textContent = `@page { size: A4 ${o}; }`;
}

function renderIndex(container) {
  const card = (r) => h('a', { class: 'report-card', href: `#/reports/${r.id}` }, h('strong', {}, r.title), r.confidential ? h('span', { class: 'badge badge-confidential' }, 'CONFIDENTIAL') : null, h('span', { class: 'muted small' }, r.subtitle));
  replace(container,
    h('div', { class: 'page-head' }, h('div', {}, h('h1', {}, 'Reports'), h('p', { class: 'lead' }, 'All reports are calculated live from the stored records. Each can be filtered, sorted, exported to CSV and printed or saved as PDF.'))),
    h('section', { class: 'card' }, h('h2', {}, 'Formatted reports'), h('div', { class: 'report-grid' }, REPORTS.filter((r) => r.primary).map(card))),
    h('section', { class: 'card' }, h('h2', {}, 'Query views'), h('div', { class: 'report-grid' }, REPORTS.filter((r) => !r.primary).map(card))));
}

function describeFilters(rep, f) {
  const parts = [];
  if (rep.filters.includes('dateRange')) parts.push(f.from || f.to ? `Dates ${f.from || 'start'} to ${f.to || 'end'}${rep.dateNote ? ` (${rep.dateNote})` : ''}` : 'All dates (all-time, including future-dated records)');
  if (f.clientId) parts.push(`Client: ${app.idx.clients.has(f.clientId) ? clientLabel(app.idx.clients.get(f.clientId)) : f.clientId}`);
  if (f.projectId) parts.push(`Project: ${projectLabel(app.idx, f.projectId)}`);
  if (f.personId) parts.push(`Employee: ${personName(app.idx, f.personId)}`);
  if (f.salespersonId) parts.push(`Salesperson: ${salespersonName(app.idx, f.salespersonId)}`);
  return parts.length ? parts.join(' · ') : 'No filters';
}

export function renderReports(container, params = {}, id = null, { standalone = false } = {}) {
  if (!id) { setPageOrientation('portrait'); renderIndex(container); return; }
  const rep = REPORT_BY_ID[id];
  if (!rep) { replace(container, h('p', {}, 'Unknown report. '), h('a', { href: '#/reports' }, 'Back to reports')); return; }
  setPageOrientation(rep.orientation);
  const f = (filterState[id] ||= { from: null, to: null, clientId: null, projectId: null, personId: null, salespersonId: null, detail: false });
  const redraw = () => renderReports(container, params, id, { standalone });
  const sel = (label, key, options) => {
    const s = h('select', { 'aria-label': label, onchange: () => { f[key] = s.value ? Number(s.value) : null; redraw(); } }, h('option', { value: '' }, `All ${label.toLowerCase()}s`), options.map((o) => h('option', { value: String(o.value) }, o.label)));
    s.value = f[key] ? String(f[key]) : '';
    return h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, label), s);
  };
  const controls = [];
  if (rep.filters.includes('dateRange')) {
    for (const [k, l] of [['from', 'From'], ['to', 'To']]) controls.push(h('label', { class: 'filter' }, h('span', { class: 'filter-label' }, l), h('input', { type: 'date', value: f[k] || '', onchange: (e) => { f[k] = e.target.value || null; redraw(); } })));
  }
  if (rep.filters.includes('client')) controls.push(sel('Client', 'clientId', clientOptions()));
  if (rep.filters.includes('project')) controls.push(sel('Project', 'projectId', projectOptions()));
  if (rep.filters.includes('person')) controls.push(sel('Employee', 'personId', personOptions()));
  if (rep.filters.includes('salesperson')) controls.push(sel('Salesperson', 'salespersonId', salespersonOptions()));

  const out = rep.build(app.idx, f);
  const hasDetail = out.tables.some((t) => t.columns.some((c) => c.detail));
  if (hasDetail) controls.push(h('label', { class: 'filter filter-check' }, h('input', { type: 'checkbox', checked: f.detail, onchange: (e) => { f.detail = e.target.checked; redraw(); } }), ' Show detail columns'));
  if (controls.length) controls.push(h('button', { type: 'button', class: 'btn btn-small', onclick: () => { filterState[id] = null; redraw(); } }, 'Clear filters'));

  const exportCsv = () => {
    const parts = out.tables.map((t) => (t.title ? `${t.title}\r\n` : '') + toCSV(t.columns, t.rows, { totals: t.totals }).replace(/^﻿/, ''));
    const header = `${rep.title}\r\n${describeFilters(rep, f)}\r\nGenerated ${new Date().toLocaleString()}\r\n\r\n`;
    downloadText(`${rep.id}_${stampForFile()}.csv`, '﻿' + header + parts.join('\r\n'), 'text/csv');
  };
  const open = (t) => t.link ? (r) => { const l = t.link(r); location.hash = l.store === 'bank' ? `#/bank?edit=${l.id}` : `#/${l.store}?edit=${l.id}`; } : null;
  const generated = new Date().toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  replace(container,
    h('div', { class: 'report-toolbar no-print' },
      standalone ? null : h('a', { href: '#/reports', class: 'btn btn-small' }, '← All reports'),
      h('div', { class: 'filters' }, controls),
      h('div', { class: 'page-actions' }, h('button', { type: 'button', class: 'btn', onclick: exportCsv }, icon.download(), ' CSV'), h('button', { type: 'button', class: 'btn btn-primary', onclick: () => window.print() }, icon.print(), ' Print / Save as PDF'))),
    h('article', { class: `report-sheet report-${rep.orientation}${rep.confidential ? ' report-confidential' : ''}` },
      h('header', { class: 'report-header' },
        h('img', { class: 'report-logo', src: logoSrc(), alt: 'Engineered Plans' }),
        h('h1', {}, rep.title), h('p', { class: 'report-subtitle' }, rep.subtitle),
        h('p', { class: 'report-filters' }, describeFilters(rep, f), ` · Generated ${generated}`),
        rep.confidential ? h('p', { class: 'confidential-banner' }, 'CONFIDENTIAL — employee banking information. Do not share or leave printed copies unattended.') : null),
      out.tables.map((t) => h('section', { class: 'report-section' }, t.title ? h('h2', {}, t.title) : null,
        dataTable({ columns: t.columns, rows: t.rows, totals: t.totals, noSort: t.noSort, showDetail: f.detail, empty: t.empty || 'No records for the selected filters.', onOpen: open(t), caption: t.title || rep.title }))),
      (out.notes || []).map((n) => h('p', { class: 'report-note' }, n)),
      out.tables.some((t) => t.link) ? h('p', { class: 'muted small no-print' }, 'Double-click a row to open that record.') : null,
      h('footer', { class: 'report-footer' }, h('span', {}, rep.confidential ? 'Engineered Plans — CONFIDENTIAL employee banking information' : 'Engineered Plans — Confidential business information'), h('span', {}, `Project Tracker · ${generated}`))));
}
