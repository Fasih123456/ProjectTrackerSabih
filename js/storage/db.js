// IndexedDB is the authoritative database. Every write is one transaction; success is reported only
// after the transaction's `complete` event. No code path clears or reseeds data on open/refresh.

import { STORES, STORE_NAMES, DB_VERSION, INTERNAL_SETUP, DEPENDENTS } from '../model/schema.js';
import { validateRecord, ctxFromDataset } from '../model/validate.js';
import { foreignRuleBlocked, dueOccurrences, recordsForOccurrence, planRuleAdjustments, occurrencesBetween, missingOccurrences, planHorizonTrim, ruleProjects, parseIdList, isSalary, endBound, nthOccurrence, salaryRuleOf, salaryRuleFor } from '../calc/recurring.js';
import { addDays } from '../lib/dates.js';
import { convertV3Contracts } from '../calc/contracts.js';
import { isForeign, applyRate } from '../calc/fx.js';

export class ValidationError extends Error { constructor(fields) { super('Please correct the highlighted fields.'); this.name = 'ValidationError'; this.fields = fields; } }
export class StaleError extends Error { constructor(msg) { super(msg); this.name = 'StaleError'; } }
export class DependencyError extends Error { constructor(msg, deps) { super(msg); this.name = 'DependencyError'; this.deps = deps; } }
export class StorageError extends Error { constructor(msg, cause) { super(msg); this.name = 'StorageError'; this.cause = cause; } }

const META = 'meta';
const SETTINGS = 'settings';
const FILES = 'files'; // contents of attachments: { AttachmentID, blob }
const FX = 'fxRates'; // cache of daily exchange rates ({ date, rates, fetchedAt }); not business data, not in backups
const ALL = [...STORE_NAMES, META, SETTINGS, FILES];
const RULE_FIELDS = [...Object.keys(STORES.recurring.fields), ...Object.keys(STORES.recurring.local)];

const req = (r) => new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });

function storageMessage(err) {
  if (!err) return 'The browser aborted the database transaction.';
  if (err.name === 'QuotaExceededError') return 'The browser storage quota is full. Nothing was saved. Export a backup and free space, then try again.';
  if (err.name === 'InvalidStateError') return 'The database connection was closed (probably by an upgrade in another tab). Reload the page and try again.';
  return `The browser could not save to its database (${err.name}: ${err.message}). Nothing was saved.`;
}

// Schema migrations. Each step runs exactly once per database, inside the versionchange transaction.
// Never delete stores or records here; only create what a version needs.
function createStore(db, s) {
  const def = STORES[s];
  const os = db.createObjectStore(s, { keyPath: def.key });
  for (const ix of def.indexes) os.createIndex(ix, ix, { unique: false });
  for (const ix of def.unique || []) os.createIndex(ix, ix, { unique: true });
}
// The ten stores of schema v1 are listed explicitly so later stores are never created twice.
const V1_STORES = ['clients', 'projects', 'people', 'salespeople', 'income', 'timeEntries', 'costs', 'activities', 'payouts', 'acquisitions'];

const MIGRATIONS = {
  1(db, tx) {
    for (const s of V1_STORES) createStore(db, s);
    db.createObjectStore(META, { keyPath: 'key' });
    db.createObjectStore(SETTINGS, { keyPath: 'key' });
    // One-time internal setup (internal client and six company cost centres).
    const now = new Date().toISOString();
    const stamp = (r) => ({ ...r, createdAt: now, updatedAt: now, revision: 1 });
    tx.objectStore('clients').add(stamp(INTERNAL_SETUP.client));
    for (const p of INTERNAL_SETUP.projects) tx.objectStore('projects').add(stamp(p));
    const nextIds = Object.fromEntries(V1_STORES.map((s) => [s, 1]));
    nextIds.clients = 2; nextIds.projects = INTERNAL_SETUP.projects.length + 1;
    tx.objectStore(META).add({ key: 'nextIds', value: nextIds });
    tx.objectStore(META).add({ key: 'setup', value: { internalSetupAt: now, createdSchemaVersion: 1 } });
  },
  // v2: recurring income/cost rules. Adds one store only; existing records are untouched.
  2(db) {
    createStore(db, 'recurring');
  },
  // v3: client contracts and their clauses. Adds two stores only; existing records are untouched.
  3(db) {
    createStore(db, 'contracts');
    createStore(db, 'clauses');
  },
  // v4: dates, renewal notice and amounts move from contracts to their clauses (see convertV3Contracts).
  // Runs inside the upgrade transaction, so it either completes fully or the database stays at v3.
  4(db, tx) {
    const cs = tx.objectStore('contracts'), ks = tx.objectStore('clauses'), meta = tx.objectStore(META);
    const all = cs.getAll();
    all.onsuccess = () => {
      if (!all.result.length) return;
      const cl = ks.getAll();
      cl.onsuccess = () => {
        const m = meta.get('nextIds');
        m.onsuccess = () => {
          const nextIds = m.result?.value || {};
          const out = convertV3Contracts(all.result, cl.result, nextIds.clauses || 1);
          for (const c of out.contracts) cs.put(c);
          for (const k of out.clauses) ks.put(k);
          meta.put({ key: 'nextIds', value: { ...nextIds, clauses: out.nextClauseId } });
        };
      };
    };
  },
  // v5: client acquisition sources. Adds one store only; existing clients simply have no SourceID yet.
  5(db) {
    createStore(db, 'sources');
  },
  // v6: multi-currency. Income, costs and recurring rules get optional currency fields (existing records stay PKR);
  // daily exchange rates are cached locally.
  6(db) {
    db.createObjectStore(FX, { keyPath: 'date' });
  },
  // v7: attachments (receipts on costs, invoices on income); descriptions in 'attachments', contents in 'files'.
  7(db) {
    createStore(db, 'attachments');
    db.createObjectStore(FILES, { keyPath: 'AttachmentID' });
  },
};

// Records of one store that have attachments get _attached: true (treated as edited by hand by the recurring logic).
function markAttached(ds, store, records) {
  const has = new Set((ds.attachments || []).filter((a) => a.Store === store).map((a) => a.RecordID));
  return records.map((x) => (has.has(x[STORES[store].key]) ? { ...x, _attached: true } : x));
}
// Deletes the attachments (description + contents) of the given records, in the caller's transaction.
async function dropAttachments(t, ds, store, recordIds) {
  const ids = new Set(recordIds);
  for (const a of (ds.attachments || []).filter((x) => x.Store === store && ids.has(x.RecordID))) {
    await req(t.objectStore('attachments').delete(a.AttachmentID));
    await req(t.objectStore(FILES).delete(a.AttachmentID));
  }
}

export class TrackerDB {
  static open(name, { onVersionChange, onBlocked } = {}) {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in globalThis) || !indexedDB) { reject(new StorageError('This browser does not provide IndexedDB, so the tracker cannot store records.')); return; }
      let r;
      try { r = indexedDB.open(name, DB_VERSION); } catch (e) { reject(new StorageError('Could not open the browser database: ' + e.message, e)); return; }
      r.onupgradeneeded = (e) => {
        const db = r.result, tx = r.transaction;
        for (let v = e.oldVersion + 1; v <= DB_VERSION; v++) MIGRATIONS[v](db, tx);
      };
      r.onblocked = () => onBlocked?.();
      r.onerror = () => reject(new StorageError(r.error?.name === 'VersionError'
        ? 'This database was created by a newer version of the tracker. Use the newer version; nothing has been changed.'
        : 'Could not open the browser database: ' + (r.error?.message || 'unknown error'), r.error));
      r.onsuccess = () => {
        const db = r.result;
        db.onversionchange = () => { db.close(); onVersionChange?.(); };
        resolve(new TrackerDB(db, name));
      };
    });
  }

  constructor(idb, name) {
    this.idb = idb; this.name = name;
    this.tabId = Math.random().toString(36).slice(2);
    this.channel = 'BroadcastChannel' in globalThis ? new BroadcastChannel('spt:' + name) : null;
    this.listeners = new Set();
    if (this.channel) this.channel.onmessage = (e) => { if (e.data?.tabId !== this.tabId) this.listeners.forEach((fn) => fn(e.data)); };
  }

  onExternalChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  #notify(msg) { try { this.channel?.postMessage({ ...msg, tabId: this.tabId }); } catch { /* channel closed */ } }
  close() { this.channel?.close(); this.idb.close(); }

  async #run(stores, mode, fn) {
    let t;
    try { t = this.idb.transaction(stores, mode, { durability: 'strict' }); } catch (e) { throw new StorageError(storageMessage(e), e); }
    const done = new Promise((res, rej) => { t.oncomplete = () => res(); t.onabort = () => rej(t.error); });
    let result;
    try { result = await fn(t); } catch (e) {
      try { t.abort(); } catch { /* already finished */ }
      await done.catch(() => {});
      if (e instanceof DOMException) throw new StorageError(storageMessage(e), e);
      throw e;
    }
    try { await done; } catch (e) { throw new StorageError(storageMessage(e), e); }
    return result;
  }

  async #readAll(t, stores = STORE_NAMES) {
    const out = {};
    for (const s of stores) out[s] = await req(t.objectStore(s).getAll());
    return out;
  }

  loadAll() { return this.#run(STORE_NAMES, 'readonly', (t) => this.#readAll(t)); }

  // In-app notifications (meta key 'notifications'): read-modify-write in one transaction so two tabs never add the
  // same notification twice or lose each other's changes. fn(list) returns the new list, or null for "no change".
  async updateNotifications(fn) {
    let changed = false;
    const list = await this.#run([META], 'readwrite', async (t) => {
      const store = t.objectStore(META);
      const cur = (await req(store.get('notifications')))?.value || [];
      const next = fn(cur);
      if (!next) return cur;
      changed = true;
      await req(store.put({ key: 'notifications', value: next }));
      return next;
    });
    if (changed) this.#notify({ type: 'meta', key: 'notifications' });
    return list;
  }

  async getMeta(key) { return this.#run([META], 'readonly', async (t) => (await req(t.objectStore(META).get(key)))?.value ?? null); }
  async setMeta(key, value) { await this.#run([META], 'readwrite', (t) => req(t.objectStore(META).put({ key, value }))); this.#notify({ type: 'meta', key }); }
  async getSettings() { return this.#run([SETTINGS], 'readonly', async (t) => Object.fromEntries((await req(t.objectStore(SETTINGS).getAll())).map((r) => [r.key, r.value]))); }
  async setSetting(key, value) {
    await this.#run([SETTINGS], 'readwrite', (t) => value === null ? req(t.objectStore(SETTINGS).delete(key)) : req(t.objectStore(SETTINGS).put({ key, value })));
    this.#notify({ type: 'settings', key });
  }

  #clean(store, data) {
    const def = STORES[store];
    const r = {};
    for (const k of [...Object.keys(def.fields), ...Object.keys(def.local)]) r[k] = data[k] === undefined ? null : data[k];
    return r;
  }

  async create(store, data) {
    const def = STORES[store];
    const rec = await this.#run(ALL, 'readwrite', async (t) => {
      const ds = await this.#readAll(t);
      const r = this.#clean(store, data);
      if (store === 'recurring') r.GeneratedThrough = null;
      const errs = validateRecord(store, { ...r, [def.key]: null }, ctxFromDataset(ds));
      if (Object.keys(errs).length) throw new ValidationError(errs);
      const metaStore = t.objectStore(META);
      const nextIds = (await req(metaStore.get('nextIds')))?.value || {};
      const maxId = ds[store].reduce((m, x) => Math.max(m, x[def.key]), 0);
      const id = Math.max(nextIds[store] || 1, maxId + 1);
      const now = new Date().toISOString();
      Object.assign(r, { [def.key]: id, createdAt: now, updatedAt: now, revision: 1 });
      await req(t.objectStore(store).add(r));
      await req(metaStore.put({ key: 'nextIds', value: { ...nextIds, [store]: id + 1 } }));
      if (store === 'people') await this.#syncSalaryRule(t, ds, r);
      return r;
    });
    this.#notify({ type: 'commit', store, id: rec[def.key] });
    return rec;
  }

  // opts.entries (recurring rules only): 'keep' leaves every entry the rule already created exactly as it is;
  // 'rebuild' replaces them all with entries made from the edited rule. Omitted: end date changes
  // correct untouched entries (#adjustRuleRecords).
  async update(store, data, expectedRevision, opts = {}) {
    const def = STORES[store];
    const id = data[def.key];
    const rec = await this.#run(ALL, 'readwrite', async (t) => {
      const current = await req(t.objectStore(store).get(id));
      if (!current) throw new StaleError(`This ${def.singular} was deleted in another tab or window. Your changes were not saved.`);
      if (current.revision !== expectedRevision) throw new StaleError(`This ${def.singular} was changed in another tab or window after you opened it. Your changes were not saved — cancel and reopen it to see the latest version.`);
      if (store === 'recurring' && isSalary(current)) { const msg = 'This salary is managed on Employees & Rates. Change the employee’s salary, join date or leave date there.'; throw Object.assign(new ValidationError({ Name: msg }), { message: msg }); }
      const ds = await this.#readAll(t);
      const r = { ...this.#clean(store, data), [def.key]: id };
      if (store === 'recurring') r.GeneratedThrough = current.GeneratedThrough ?? null; // generator-managed, never from the form
      const errs = validateRecord(store, r, ctxFromDataset(ds), current);
      if (Object.keys(errs).length) throw new ValidationError(errs);
      Object.assign(r, { createdAt: current.createdAt ?? null, updatedAt: new Date().toISOString(), revision: current.revision + 1 });
      const adjusted = store !== 'recurring' || opts.entries === 'keep' ? null
        : opts.entries === 'rebuild' ? await this.#rebuildRuleRecords(t, ds, current, r)
          : await this.#adjustRuleRecords(t, ds, current, r);
      await req(t.objectStore(store).put(r));
      const salary = store === 'people' ? await this.#syncSalaryRule(t, ds, r) : null;
      return adjusted ? { ...r, _adjusted: adjusted } : salary?.adjusted ? { ...r, _adjusted: salary.adjusted } : r;
    });
    this.#notify({ type: 'commit', store, id });
    return rec;
  }

  // Recurring rule: a changed end date (or a salary's join date) corrects already-created records that were not
  // edited by hand (remove occurrences after the end date; add or remove salary months when the join date moves) in the
  // caller's transaction. Updates r.GeneratedThrough in place. Returns counts, or null when nothing relevant changed.
  async #adjustRuleRecords(t, ds, current, r) {
    const startMoved = isSalary(current) && current.StartDate !== r.StartDate;
    if (current.EndDate === r.EndDate && !startMoved) return null;
    const target = current.Kind === 'Income' ? 'income' : 'costs';
    const mine = markAttached(ds, target, ds[target].filter((x) => x.RecurringID === current.RecurringID));
    const plan = planRuleAdjustments(current, r, mine);
    const now = new Date().toISOString();
    for (const u of plan.updates) await req(t.objectStore(target).put({ ...u, updatedAt: now, revision: u.revision + 1 }));
    for (const d of plan.deletes) await req(t.objectStore(target).delete(d[STORES[target].key]));
    let created = 0;
    if (r.GeneratedThrough) {
      // Progress = last scheduled occurrence up to the old progress, within the new schedule (from the schedule, so
      // occurrences you deleted by hand earlier are still never recreated). Extending the end date later resumes from there.
      const sched = occurrencesBetween(r, null, endBound(r) || addDays(r.GeneratedThrough, 1)).filter((d) => d <= r.GeneratedThrough);
      r.GeneratedThrough = sched.length ? sched[sched.length - 1] : null;
      // A salary whose join date moved earlier: the months before the old join month are added now.
      const oldFirst = nthOccurrence(current, 0);
      if (startMoved && r.GeneratedThrough) created = await this.#addOccurrences(t, ds, r, sched.filter((d) => d < oldFirst));
    }
    return { updated: plan.updates.length, deleted: plan.deletes.length, skipped: plan.skipped.length, created };
  }

  // Recurring rule edited with "update existing entries": every entry the rule created (hand-edited ones included) is
  // deleted and re-made from the edited rule for each of its occurrences up to the old progress, so amount, name,
  // project, split, notes, dates and end date all apply to the past too. Later occurrences follow as usual.
  // Entries with receipts / invoices attached are kept as they are (never deleted here), and their occurrence is not re-made.
  async #rebuildRuleRecords(t, ds, current, r) {
    let deleted = 0, kept = 0;
    const keep = new Set();
    for (const s of ['income', 'costs']) {
      for (const x of markAttached(ds, s, ds[s].filter((y) => y.RecurringID === current.RecurringID))) {
        if (x._attached) { keep.add(`${s}|${x.StartDate}|${x.ProjectID}`); kept++; continue; }
        await req(t.objectStore(s).delete(x[STORES[s].key])); deleted++;
      }
    }
    const dates = current.GeneratedThrough ? occurrencesBetween(r, null, addDays(current.GeneratedThrough, 1)) : [];
    r.GeneratedThrough = dates.length ? dates[dates.length - 1] : null;
    const created = await this.#addOccurrences(t, ds, r, dates, keep);
    return { rebuilt: true, deleted, created, updated: 0, skipped: kept };
  }

  // Adds the income/cost records of the given occurrence dates for a rule (in the caller's transaction).
  async #addOccurrences(t, ds, rule, dates, skip = null) {
    if (!dates.length) return 0;
    if (foreignRuleBlocked(rule)) throw new ValidationError({ Currency: `No ${rule.Currency} exchange rate is available yet (are you offline?). Open Currencies and refresh the rates, then try again.` });
    const metaStore = t.objectStore(META);
    const nextIds = { ...((await req(metaStore.get('nextIds')))?.value || {}) };
    const now = new Date().toISOString();
    let n = 0;
    for (const d of dates) {
      for (const { store, record } of recordsForOccurrence(rule, d)) {
        if (skip?.has(`${store}|${d}|${record.ProjectID}`)) continue; // an attached entry already covers it
        const key = STORES[store].key;
        nextIds[store] = Math.max(nextIds[store] || 1, ds[store].reduce((m, x) => Math.max(m, x[key]), 0) + 1);
        await req(t.objectStore(store).add({ ...this.#clean(store, record), [key]: nextIds[store]++, createdAt: now, updatedAt: now, revision: 1 }));
        n++;
      }
    }
    await req(metaStore.put({ key: 'nextIds', value: nextIds }));
    return n;
  }

  // Keeps an employee's salary rule in step with the employee (in the caller's transaction): created when a join date
  // and salary are first set, updated on every save (end/join date corrections apply to existing entries as for any
  // rule), paused when no salary is due. Entries are generated by generateRecurring as usual.
  async #syncSalaryRule(t, ds, person) {
    const existing = salaryRuleOf(person, ds.recurring);
    const next = salaryRuleFor(person, existing, ds.projects);
    if (!next) return null;
    const now = new Date().toISOString();
    if (!existing) {
      const metaStore = t.objectStore(META);
      const nextIds = (await req(metaStore.get('nextIds')))?.value || {};
      const id = Math.max(nextIds.recurring || 1, ds.recurring.reduce((m, x) => Math.max(m, x.RecurringID), 0) + 1);
      const r = { ...this.#clean('recurring', next), RecurringID: id, GeneratedThrough: null, createdAt: now, updatedAt: now, revision: 1 };
      const errs = validateRecord('recurring', { ...r, RecurringID: null }, ctxFromDataset(ds));
      if (Object.keys(errs).length) throw new ValidationError({ MonthlyReferenceValue: 'The salary schedule could not be created: ' + Object.values(errs).join(' ') });
      await req(t.objectStore('recurring').add(r));
      await req(metaStore.put({ key: 'nextIds', value: { ...nextIds, recurring: id + 1 } }));
      return { rule: r, adjusted: null };
    }
    const r = { ...this.#clean('recurring', next), RecurringID: existing.RecurringID };
    if (RULE_FIELDS.every((k) => (r[k] ?? null) === (existing[k] ?? null))) return { rule: existing, adjusted: null };
    const adjusted = await this.#adjustRuleRecords(t, ds, existing, r);
    Object.assign(r, { createdAt: existing.createdAt ?? null, updatedAt: now, revision: existing.revision + 1 });
    await req(t.objectStore('recurring').put(r));
    return { rule: r, adjusted };
  }

  // Returns dependents (records referencing the given parent) without changing anything.
  async dependentsOf(store, id) { return this.#run(STORE_NAMES, 'readonly', async (t) => findDependents(await this.#readAll(t), store, id)); }

  // opts.withEntries (recurring rules only): also deletes every income/cost entry the rule created, in the same
  // transaction. Otherwise those entries stay as ordinary records. Returns the number of entries deleted.
  async remove(store, id, expectedRevision, opts = {}) {
    const def = STORES[store];
    let removedEntries = 0;
    await this.#run(ALL, 'readwrite', async (t) => {
      const current = await req(t.objectStore(store).get(id));
      if (!current) throw new StaleError(`This ${def.singular} was already deleted in another tab or window.`);
      if (current.revision !== expectedRevision) throw new StaleError(`This ${def.singular} was changed in another tab or window. Reload before deleting it.`);
      if (store === 'recurring' && isSalary(current) && (await req(t.objectStore('people').get(current.PersonID)))) throw new DependencyError('This salary is managed on Employees & Rates. Set a leave date there to stop it.', []);
      const ds = await this.#readAll(t);
      const deps = findDependents(ds, store, id);
      if (deps.length) throw new DependencyError(`This ${def.singular} cannot be deleted because other records depend on it.`, deps);
      await req(t.objectStore(store).delete(id));
      if (store === 'income' || store === 'costs') await dropAttachments(t, ds, store, [id]); // its receipts / invoices go with it
      if (store === 'recurring' && opts.withEntries) {
        for (const s of ['income', 'costs']) {
          const gone = ds[s].filter((y) => y.RecurringID === id).map((x) => x[STORES[s].key]);
          for (const k of gone) { await req(t.objectStore(s).delete(k)); removedEntries++; }
          await dropAttachments(t, ds, s, gone);
        }
      }
      // An employee's salary rule goes with them (findDependents already refused if it had created any entries).
      if (store === 'people') { const rule = salaryRuleOf(current, ds.recurring); if (rule) await req(t.objectStore('recurring').delete(rule.RecurringID)); }
    });
    this.#notify({ type: 'commit', store, id });
    return removedEntries;
  }

  // Adds many new records to one store in a single all-or-nothing transaction (existing records untouched).
  // Every record gets a new ID above the current maximum and is validated like a normal Submit.
  async createMany(store, list) {
    const def = STORES[store];
    const created = await this.#run(ALL, 'readwrite', async (t) => {
      const ds = await this.#readAll(t);
      const ctx = ctxFromDataset(ds);
      const metaStore = t.objectStore(META);
      const nextIds = (await req(metaStore.get('nextIds')))?.value || {};
      let id = Math.max(nextIds[store] || 1, ds[store].reduce((m, x) => Math.max(m, x[def.key]), 0) + 1);
      const now = new Date().toISOString();
      const out = [];
      for (const [i, data] of list.entries()) {
        const r = this.#clean(store, data);
        const errs = validateRecord(store, { ...r, [def.key]: null }, ctx);
        if (Object.keys(errs).length) throw new ValidationError(Object.fromEntries(Object.entries(errs).map(([k, v]) => [k, `Row ${i + 1}: ${v}`])));
        Object.assign(r, { [def.key]: id++, createdAt: now, updatedAt: now, revision: 1 });
        await req(t.objectStore(store).add(r));
        out.push(r);
      }
      await req(metaStore.put({ key: 'nextIds', value: { ...nextIds, [store]: id } }));
      return out;
    });
    this.#notify({ type: 'commit', store });
    return created;
  }

  // Edits one record and adds new ones beside it in a single all-or-nothing transaction (e.g. an existing cost
  // split across more projects). Same stale-edit protection and validation as update/create.
  async updateAndCreate(store, data, expectedRevision, extras) {
    const def = STORES[store];
    const id = data[def.key];
    const out = await this.#run(ALL, 'readwrite', async (t) => {
      const current = await req(t.objectStore(store).get(id));
      if (!current) throw new StaleError(`This ${def.singular} was deleted in another tab or window. Your changes were not saved.`);
      if (current.revision !== expectedRevision) throw new StaleError(`This ${def.singular} was changed in another tab or window after you opened it. Your changes were not saved — cancel and reopen it to see the latest version.`);
      const ds = await this.#readAll(t);
      const ctx = ctxFromDataset(ds);
      const now = new Date().toISOString();
      const r = { ...this.#clean(store, data), [def.key]: id };
      const errs = validateRecord(store, r, ctx, current);
      if (Object.keys(errs).length) throw new ValidationError(errs);
      Object.assign(r, { createdAt: current.createdAt ?? null, updatedAt: now, revision: current.revision + 1 });
      await req(t.objectStore(store).put(r));
      const metaStore = t.objectStore(META);
      const nextIds = (await req(metaStore.get('nextIds')))?.value || {};
      let next = Math.max(nextIds[store] || 1, ds[store].reduce((m, x) => Math.max(m, x[def.key]), 0) + 1);
      const added = [];
      for (const x of extras) {
        const n = this.#clean(store, x);
        const e = validateRecord(store, { ...n, [def.key]: null }, ctx);
        if (Object.keys(e).length) throw new ValidationError(e);
        Object.assign(n, { [def.key]: next++, createdAt: now, updatedAt: now, revision: 1 });
        await req(t.objectStore(store).add(n));
        added.push(n);
      }
      await req(metaStore.put({ key: 'nextIds', value: { ...nextIds, [store]: next } }));
      return [r, ...added];
    });
    this.#notify({ type: 'commit', store, id });
    return out;
  }

  // Keeps recurring entries in step with the look-ahead window (dates up to 14 days after `today`), in one
  // transaction: (1) untouched entries beyond the window (e.g. created under the old one-month window) are removed
  // and their dates rewound so they come back on time; (2) entries now due are created. GeneratedThrough moves in
  // the same transaction, so a date is never generated twice — even with several tabs open — and an occurrence you
  // deleted is not recreated. Rule revisions are unchanged (system field), so open editors are not made stale.
  async generateRecurring(today) {
    const result = await this.#run(ALL, 'readwrite', async (t) => {
      const rules = await req(t.objectStore('recurring').getAll());
      const metaStore = t.objectStore(META);
      const nextIds = { ...((await req(metaStore.get('nextIds')))?.value || {}) };
      const now = new Date().toISOString();
      // rules: per rule, what was added in this run (for the "recurring entry added" notification)
      const created = { income: 0, costs: 0, removed: 0, dates: [], rules: [] };
      const ready = new Set();
      const generated = [];
      for (const s of ['income', 'costs']) for (const x of await req(t.objectStore(s).getAll())) if (x.RecurringID) generated.push({ ...x, _store: s });
      const attachedKeys = new Set((await req(t.objectStore('attachments').getAll())).map((a) => `${a.Store}|${a.RecordID}`));
      for (let rule of rules) {
        if (!rule.Archived && rule.GeneratedThrough) {
          const linked = generated.filter((x) => x.RecurringID === rule.RecurringID).map((x) => (attachedKeys.has(`${x._store}|${x[STORES[x._store].key]}`) ? { ...x, _attached: true } : x));
          const trim = planHorizonTrim(rule, linked, today);
          for (const x of trim.deletes) { await req(t.objectStore(x._store).delete(x[STORES[x._store].key])); created.removed++; }
          if (trim.generatedThrough !== rule.GeneratedThrough) {
            rule = { ...rule, GeneratedThrough: trim.generatedThrough };
            await req(t.objectStore('recurring').put(rule));
          }
        }
        const dates = dueOccurrences(rule, today);
        if (!dates.length) continue;
        if (foreignRuleBlocked(rule)) continue; // no exchange rate known yet: added on a later run
        let projectsOk = true;
        for (const pid of ruleProjects(rule)) if (!(await req(t.objectStore('projects').get(pid)))) projectsOk = false;
        if (!projectsOk) continue; // reported in Data Quality
        const summary = { ruleId: rule.RecurringID, name: rule.Name, kind: rule.Kind, projectIds: ruleProjects(rule), ids: [], dates: [], amounts: [] };
        for (const d of dates) {
          for (const { store, record } of recordsForOccurrence(rule, d)) {
            const key = STORES[store].key;
            if (!ready.has(store)) { const keys = await req(t.objectStore(store).getAllKeys()); nextIds[store] = Math.max(nextIds[store] || 1, (keys.length ? Math.max(...keys) : 0) + 1); ready.add(store); }
            const r = { ...this.#clean(store, record), [key]: nextIds[store]++, createdAt: now, updatedAt: now, revision: 1 };
            await req(t.objectStore(store).add(r));
            created[store]++;
            summary.ids.push(r[key]); summary.amounts.push(store === 'income' ? r.AmountPaid : r.CostAmount);
          }
          created.dates.push(d); summary.dates.push(d);
        }
        created.rules.push(summary);
        await req(t.objectStore('recurring').put({ ...rule, GeneratedThrough: dates[dates.length - 1] }));
      }
      if (created.income || created.costs) await req(metaStore.put({ key: 'nextIds', value: nextIds }));
      return created;
    });
    if (result.income || result.costs || result.removed) this.#notify({ type: 'commit', store: 'recurring' });
    return result;
  }

  // ---------- exchange rates ----------
  async getFxDay(date) { return this.#run([FX], 'readonly', async (t) => (await req(t.objectStore(FX).get(date))) ?? null); }
  async putFxDay(day) { await this.#run([FX], 'readwrite', (t) => req(t.objectStore(FX).put(day))); }
  // The most recent cached day (or null).
  async latestFxDay() {
    return this.#run([FX], 'readonly', (t) => new Promise((resolve, reject) => {
      const c = t.objectStore(FX).openCursor(null, 'prev');
      c.onsuccess = () => resolve(c.result ? c.result.value : null);
      c.onerror = () => reject(c.error);
    }));
  }

  // Applies exchange rates to income/cost records in one transaction: updates = [{ store, id, rate, date, status }].
  // Records that are no longer in another currency, or carry a typed-in (manual) rate, are left alone. Each changed
  // record gets a new revision, so an editor open on it in another tab cannot overwrite it unnoticed.
  async applyFxRates(updates) {
    if (!updates.length) return 0;
    const n = await this.#run(['income', 'costs'], 'readwrite', async (t) => {
      const now = new Date().toISOString();
      let changed = 0;
      for (const u of updates) {
        const os = t.objectStore(u.store);
        const r = await req(os.get(u.id));
        if (!r || !isForeign(r) || r.FxStatus === 'manual') continue;
        if (r.FxRate === u.rate && r.FxDate === u.date && r.FxStatus === u.status) continue;
        applyRate(u.store, r, u.rate, u.date, u.status);
        await req(os.put({ ...r, updatedAt: now, revision: (r.revision || 1) + 1 }));
        changed++;
      }
      return changed;
    });
    if (n) this.#notify({ type: 'commit', store: 'fx' });
    return n;
  }

  // Explicit user action: re-create a rule's already-scheduled occurrences that have no record any more,
  // using the rule's current amount/name/project. One transaction; returns the new records.
  async recreateMissingRecurring(ruleId) {
    const created = await this.#run(ALL, 'readwrite', async (t) => {
      const rule = await req(t.objectStore('recurring').get(ruleId));
      if (!rule) throw new StaleError('This recurring transaction no longer exists.');
      for (const pid of ruleProjects(rule)) if (!(await req(t.objectStore('projects').get(pid)))) throw new ValidationError({ ProjectID: 'One of the rule’s projects no longer exists. Edit the rule first.' });
      const ds = await this.#readAll(t, ['income', 'costs']);
      const dates = missingOccurrences(rule, ds);
      if (dates.length && foreignRuleBlocked(rule)) throw new ValidationError({ Currency: `No ${rule.Currency} exchange rate is available yet. Open Currencies and refresh the rates, then try again.` });
      const metaStore = t.objectStore(META);
      const nextIds = { ...((await req(metaStore.get('nextIds')))?.value || {}) };
      const now = new Date().toISOString();
      const out = [], ready = new Set();
      for (const d of dates) {
        for (const { store, record } of recordsForOccurrence(rule, d)) {
          const key = STORES[store].key;
          if (!ready.has(store)) { nextIds[store] = Math.max(nextIds[store] || 1, ds[store].reduce((m, x) => Math.max(m, x[key]), 0) + 1); ready.add(store); }
          const r = { ...this.#clean(store, record), [key]: nextIds[store]++, createdAt: now, updatedAt: now, revision: 1 };
          await req(t.objectStore(store).add(r));
          out.push(r);
        }
      }
      if (out.length) await req(metaStore.put({ key: 'nextIds', value: nextIds }));
      return out;
    });
    if (created.length) this.#notify({ type: 'commit', store: 'recurring', id: ruleId });
    return created;
  }

  // Atomic replacement for restore/import. The dataset must already be validated.
  // `_testFailAfterWrites` exists only so tests can prove an aborted restore leaves data intact.
  // files: [{ AttachmentID, blob }] (contents of the restored attachments; the files store is always replaced).
  async replaceAll(ds, { nextIds, settings, files = [], _testFailAfterWrites = false } = {}) {
    await this.#run(ALL, 'readwrite', async (t) => {
      const now = new Date().toISOString();
      const fs = t.objectStore(FILES);
      await req(fs.clear());
      for (const f of files) await req(fs.put(f));
      for (const s of STORE_NAMES) {
        const os = t.objectStore(s);
        await req(os.clear());
        for (const r of ds[s]) await req(os.add({ ...r, createdAt: r.createdAt ?? now, updatedAt: r.updatedAt ?? now, revision: r.revision ?? 1 }));
      }
      const computed = Object.fromEntries(STORE_NAMES.map((s) => [s, Math.max(nextIds?.[s] || 1, ds[s].reduce((m, x) => Math.max(m, x[STORES[s].key]), 0) + 1)]));
      await req(t.objectStore(META).put({ key: 'nextIds', value: computed }));
      if (settings) {
        const ss = t.objectStore(SETTINGS);
        await req(ss.clear());
        for (const [key, value] of Object.entries(settings)) await req(ss.put({ key, value }));
      }
      if (_testFailAfterWrites) throw new StorageError('Simulated failure after writes (test).');
    });
    this.#notify({ type: 'replace' });
  }

  // ---------- attachments ----------
  // Adds files to an income / cost record in one transaction. files: [{ name, type, size, blob }]. Returns the new descriptions.
  async addAttachments(store, recordId, files) {
    if (!files.length) return [];
    if (store !== 'income' && store !== 'costs') throw new ValidationError({ Store: 'Files can only be attached to income or costs.' });
    const out = await this.#run(ALL, 'readwrite', async (t) => {
      if (!(await req(t.objectStore(store).get(recordId)))) throw new StaleError(`This ${STORES[store].singular} no longer exists, so the file could not be attached.`);
      const metaStore = t.objectStore(META);
      const nextIds = { ...((await req(metaStore.get('nextIds')))?.value || {}) };
      const keys = await req(t.objectStore('attachments').getAllKeys());
      let next = Math.max(nextIds.attachments || 1, (keys.length ? Math.max(...keys) : 0) + 1);
      const now = new Date().toISOString();
      const made = [];
      for (const f of files) {
        const r = { AttachmentID: next++, Store: store, RecordID: recordId, FileName: String(f.name || 'file').slice(0, 255), MimeType: String(f.type || 'application/octet-stream').slice(0, 120), Size: f.size, createdAt: now, updatedAt: now, revision: 1 };
        await req(t.objectStore('attachments').add(r));
        await req(t.objectStore(FILES).put({ AttachmentID: r.AttachmentID, blob: f.blob }));
        made.push(r);
      }
      nextIds.attachments = next;
      await req(metaStore.put({ key: 'nextIds', value: nextIds }));
      return made;
    });
    this.#notify({ type: 'commit', store: 'attachments' });
    return out;
  }
  async removeAttachments(ids) {
    if (!ids.length) return;
    await this.#run(ALL, 'readwrite', async (t) => {
      for (const id of ids) { await req(t.objectStore('attachments').delete(id)); await req(t.objectStore(FILES).delete(id)); }
    });
    this.#notify({ type: 'commit', store: 'attachments' });
  }
  async getFile(id) { return this.#run([FILES], 'readonly', async (t) => (await req(t.objectStore(FILES).get(id)))?.blob ?? null); }
  async allFiles() { return this.#run([FILES], 'readonly', (t) => req(t.objectStore(FILES).getAll())); }

  async exportRaw() {
    return this.#run([...STORE_NAMES, META, SETTINGS], 'readonly', async (t) => {
      const stores = await this.#readAll(t);
      const nextIds = (await req(t.objectStore(META).get('nextIds')))?.value || {};
      const settings = Object.fromEntries((await req(t.objectStore(SETTINGS).getAll())).map((r) => [r.key, r.value]));
      return { stores, nextIds, settings };
    });
  }
}

export function findDependents(ds, store, id) {
  const out = [];
  for (const { store: s, field } of DEPENDENTS[store] || []) {
    // A project is also used by recurring cost rules that split with it.
    const rows = ds[s].filter((r) => r[field] === id || (s === 'recurring' && store === 'projects' && parseIdList(r.SplitProjects).includes(id)));
    if (rows.length) out.push({ store: s, field, count: rows.length, ids: rows.map((r) => r[STORES[s].key]) });
  }
  // A source that clients point to (SourceID is a tracker-only field, so it is not in DEPENDENTS).
  if (store === 'sources') {
    const rows = ds.clients.filter((c) => c.SourceID === id);
    if (rows.length) out.push({ store: 'clients', field: 'SourceID', count: rows.length, ids: rows.map((c) => c.ClientID) });
  }
  // An employee whose salary rule has already created cost entries.
  if (store === 'people') {
    const rule = (ds.recurring || []).find((r) => r.PersonID === id && isSalary(r));
    const rows = rule ? ds.costs.filter((c) => c.RecurringID === rule.RecurringID) : [];
    if (rows.length) out.push({ store: 'costs', field: 'RecurringID', count: rows.length, ids: rows.map((c) => c.CostID) });
  }
  // …and by contracts that cover it (contracts have no ProjectID field, so they are not in DEPENDENTS.projects).
  if (store === 'projects') {
    const rows = (ds.contracts || []).filter((c) => parseIdList(c.ProjectIDs).includes(id));
    if (rows.length) out.push({ store: 'contracts', field: 'ProjectIDs', count: rows.length, ids: rows.map((c) => c.ContractID) });
  }
  return out;
}

// Request persistent storage and describe the honest result.
export async function storageStatus({ request = false } = {}) {
  const sm = navigator.storage;
  const out = { supported: !!sm, persisted: null, requested: false, usage: null, quota: null, error: null };
  if (!sm) return out;
  try {
    if (sm.persisted) out.persisted = await sm.persisted();
    if (request && sm.persist && !out.persisted) { out.requested = true; out.persisted = await sm.persist(); }
    if (sm.estimate) { const e = await sm.estimate(); out.usage = e.usage ?? null; out.quota = e.quota ?? null; }
  } catch (e) { out.error = e.message; }
  return out;
}
