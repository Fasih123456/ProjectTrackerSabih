// Shared application state. `ds` is a read-only snapshot reloaded from IndexedDB after every commit.
import { buildIndex, projectLabel, salespersonName, clientLabel, clientNameById } from '../calc/calc.js';

export const app = {
  db: null, dbName: null, mode: 'live',
  ds: null, idx: null, settings: {}, storage: null, lastBackupAt: null,
  editor: null,           // { isDirty(), discard(), externalChange() } while a form is open
  render: () => {},       // re-renders the current view (set by app.js)
  async reload() {
    this.ds = await this.db.loadAll();
    this.idx = buildIndex(this.ds);
    this.settings = await this.db.getSettings();
    this.lastBackupAt = await this.db.getMeta('lastBackupAt');
    this.afterReload?.(); // e.g. re-check notifications after a save (not awaited)
  },
  afterReload: null,
};

const byLabel = (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: 'base' }) || a.value - b.value;

// A project is hidden like an archived one when it is archived, or when every contract covering it has ended.
export const projectHiddenReason = (p) => (p.Archived ? 'archived' : app.idx.contractEnded.has(p.ProjectID) ? 'contract ended' : null);

// Selector options. Archived records are hidden unless they are the current value.
export function projectOptions(current = null, { clientOnly = false, clientId = null, includeHidden = false } = {}) {
  return app.ds.projects
    .filter((p) => (includeHidden || !projectHiddenReason(p) || p.ProjectID === current) && (!clientOnly || p.ProjectType === 'Client') && (clientId === null || p.ClientID === clientId))
    .map((p) => { const why = projectHiddenReason(p); return { value: p.ProjectID, label: projectLabel(app.idx, p.ProjectID) + (why ? ` (${why})` : ''), group: p.ProjectType === 'Client' ? 'Client projects' : 'Internal cost centres' }; })
    .sort((a, b) => (a.group === b.group ? 0 : a.group === 'Client projects' ? -1 : 1) || byLabel(a, b));
}
export function clientOptions(current = null, { nonInternal = false } = {}) {
  return app.ds.clients.filter((c) => (!c.Archived || c.ClientID === current) && (!nonInternal || !c.IsInternal))
    .map((c) => ({ value: c.ClientID, label: clientLabel(c) + (c.IsInternal ? ' (internal)' : '') + (c.Archived ? ' (archived)' : '') })).sort(byLabel);
}
export function contractOptions() {
  return app.ds.contracts.map((c) => ({ value: c.ContractID, label: `${clientNameById(app.idx, c.ClientID)} / ${c.ContractName}` })).sort(byLabel);
}
export function sourceOptions(current = null) {
  return (app.ds.sources || []).filter((s) => !s.Archived || s.SourceID === current).map((s) => ({ value: s.SourceID, label: s.SourceName + (s.Archived ? ' (archived)' : '') })).sort(byLabel);
}
export function personOptions(current = null) {
  return app.ds.people.filter((p) => !p.Archived || p.PersonID === current).map((p) => ({ value: p.PersonID, label: p.PersonName + (p.Archived ? ' (archived)' : '') })).sort(byLabel);
}
export function salespersonOptions(current = null) {
  return app.ds.salespeople.filter((s) => !s.Archived || s.SalespersonID === current).map((s) => ({ value: s.SalespersonID, label: salespersonName(app.idx, s.SalespersonID) + (s.Archived ? ' (archived)' : '') })).sort(byLabel);
}
