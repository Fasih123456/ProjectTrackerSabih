// Import of the portable Access export (reference/access-data.json). Separate from backup restore.
// Preserves IDs, nulls, four-decimal money, dates, blank descriptions and every source row.
import { STORES, STORE_NAMES, ACCESS_STORE_NAMES, TABLE_TO_STORE, ACCESS_FORMAT, CATEGORY_CODE_BY_NAME } from '../model/schema.js';
import { validateDataset } from '../model/validate.js';
import { Dec } from '../lib/decimal.js';

export function parseAccessExport(text) {
  const errors = [], warnings = [];
  let src;
  try { src = JSON.parse(text); } catch (e) { return { ok: false, errors: ['The file is not valid JSON: ' + e.message], warnings }; }
  if (!src || src.format !== ACCESS_FORMAT) return { ok: false, errors: ['This is not a Engineered Plans Access export (expected format "engineeredplans-access-export"). To restore an app backup, use "Restore backup".'], warnings };
  if (src.formatVersion !== 1) return { ok: false, errors: [`Unsupported Access export version ${src.formatVersion}.`], warnings };
  if (!src.tables || typeof src.tables !== 'object') return { ok: false, errors: ['The export has no tables section.'], warnings };
  for (const t of Object.keys(src.tables)) if (!TABLE_TO_STORE[t]) warnings.push(`Table ${t} is not part of the tracker and was ignored.`);

  const stores = {};
  const categoryMap = [];
  for (const s of STORE_NAMES) if (STORES[s].localOnly) stores[s] = []; // tracker-only stores (recurring rules) start empty
  for (const s of ACCESS_STORE_NAMES) {
    const def = STORES[s];
    const rows = src.tables[def.table];
    if (!Array.isArray(rows)) { errors.push(`Table ${def.table} is missing (an empty table must still be present as []).`); stores[s] = []; continue; }
    stores[s] = rows.map((row, i) => {
      if (!row || typeof row !== 'object') { errors.push(`${def.table} row ${i + 1} is not a record`); return {}; }
      const r = {};
      for (const [k, fd] of Object.entries(def.fields)) {
        let v = row[k];
        if (v === undefined) { errors.push(`${def.table} row ${i + 1}: field ${k} is missing`); continue; }
        // Money is already decoded to PKR. Only pad to 4 decimals (never rescale, never round).
        if (fd.type === 'money' && typeof v === 'string' && /^-?\d+(\.\d{1,4})?$/.test(v)) v = Dec.from(v).toFixed(4);
        r[k] = v;
      }
      for (const k of Object.keys(row)) if (!(k in def.fields)) warnings.push(`${def.table} row ${i + 1}: unknown field ${k} ignored`);
      for (const k of Object.keys(def.local)) r[k] = null;
      if (s === 'projects' && r.ProjectType === 'Internal' && CATEGORY_CODE_BY_NAME[r.ProjectName]) {
        r.CategoryCode = CATEGORY_CODE_BY_NAME[r.ProjectName];
        categoryMap.push({ ProjectID: r.ProjectID, ProjectName: r.ProjectName, CategoryCode: r.CategoryCode });
      }
      return r;
    });
  }
  if (errors.length) return { ok: false, errors, warnings };
  const v = validateDataset(stores, { strictMoney: true, allowMeta: false, allowUnknown: false });
  errors.push(...v.errors); warnings.push(...v.warnings);
  const counts = Object.fromEntries(STORE_NAMES.map((s) => [s, stores[s].length]));
  return { ok: errors.length === 0, errors, warnings, counts, categoryMap, sourceFile: src.sourceFile, exportedAt: src.exportedAt, data: { stores, nextIds: {}, settings: null } };
}

export async function importParsed(db, parsed) {
  if (!parsed?.ok) throw new Error('Refusing to import an invalid Access export.');
  // Settings (custom logo) are kept; only the ten business stores and ID counters are replaced.
  await db.replaceAll(parsed.data.stores, { nextIds: {} });
}

// Converts current records back to the Access export shape (original table/field names).
export function toAccessShape(ds) {
  const tables = {};
  for (const s of ACCESS_STORE_NAMES) tables[STORES[s].table] = ds[s].map((r) => Object.fromEntries(Object.keys(STORES[s].fields).map((k) => [k, r[k]])));
  return { format: ACCESS_FORMAT, formatVersion: 1, currency: 'PKR', tables };
}
