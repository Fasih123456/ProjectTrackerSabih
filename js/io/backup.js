// Full versioned JSON backup and validated, atomic restore.
import { STORES, STORE_NAMES, DB_VERSION, APP_VERSION, BACKUP_FORMAT, BACKUP_VERSION } from '../model/schema.js';
import { validateDataset } from '../model/validate.js';
import { convertV3Contracts } from '../calc/contracts.js';
import { BASE } from '../calc/fx.js';

// Attachment contents travel in the backup as data URLs (base64): [{ AttachmentID, dataUrl }].
const blobToDataUrl = (blob) => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
function dataUrlToBlob(url) {
  const m = /^data:([^;,]*)(;base64)?,(.*)$/s.exec(url);
  const bin = m[2] ? atob(m[3]) : decodeURIComponent(m[3]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: m[1] || 'application/octet-stream' });
}

export async function buildBackup(db) {
  const raw = await db.exportRaw();
  const files = [];
  for (const x of (await db.allFiles()).sort((a, b) => a.AttachmentID - b.AttachmentID)) files.push({ AttachmentID: x.AttachmentID, dataUrl: await blobToDataUrl(x.blob) });
  const stores = {};
  for (const s of STORE_NAMES) stores[s] = [...raw.stores[s]].sort((a, b) => a[STORES[s].key] - b[STORES[s].key]);
  return {
    format: BACKUP_FORMAT, backupVersion: BACKUP_VERSION, schemaVersion: DB_VERSION, appVersion: APP_VERSION,
    exportedAt: new Date().toISOString(), database: db.name, currency: BASE,
    currencyEncoding: 'decimal string, four decimal places (Access Currency precision)', dateEncoding: 'YYYY-MM-DD calendar dates',
    tableNames: Object.fromEntries(STORE_NAMES.map((s) => [s, STORES[s].table])),
    counts: Object.fromEntries(STORE_NAMES.map((s) => [s, stores[s].length])),
    nextIds: raw.nextIds, settings: raw.settings, stores, files,
  };
}

export const backupJSON = (b) => JSON.stringify(b, null, 2);

function validSettings(settings, errors) {
  if (settings === undefined || settings === null) return {};
  if (typeof settings !== 'object' || Array.isArray(settings)) { errors.push('settings must be an object'); return {}; }
  const logo = settings.logo;
  if (logo !== undefined && logo !== null && !(typeof logo === 'object' && typeof logo.dataUrl === 'string' && /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.test(logo.dataUrl))) errors.push('settings.logo is not a valid embedded image');
  const cur = settings.currencies;
  if (cur !== undefined && cur !== null && !(Array.isArray(cur) && cur.every((c) => typeof c === 'string' && /^[A-Z]{3}$/.test(c)))) errors.push('settings.currencies must be a list of 3-letter currency codes');
  return settings;
}

// Parses and validates the whole file before anything is written. Returns a preview object.
export function parseBackup(text) {
  const errors = [], warnings = [];
  let b;
  try { b = JSON.parse(text); } catch (e) { return { ok: false, errors: ['The file is not valid JSON: ' + e.message], warnings }; }
  if (!b || typeof b !== 'object' || b.format !== BACKUP_FORMAT) return { ok: false, errors: ['This is not a Engineered Plans Project Tracker backup file. (To load the original Access data, use "Import Access export" instead.)'], warnings };
  if (!Number.isInteger(b.backupVersion) || b.backupVersion < 1) errors.push('Backup version is missing or invalid.');
  else if (b.backupVersion > BACKUP_VERSION) errors.push(`This backup was made by a newer tracker (backup version ${b.backupVersion}); this version supports up to ${BACKUP_VERSION}. Nothing was changed.`);
  if (Number.isInteger(b.schemaVersion) && b.schemaVersion > DB_VERSION) errors.push(`This backup uses a newer database schema (${b.schemaVersion}). Nothing was changed.`);
  if (!b.stores || typeof b.stores !== 'object') errors.push('The backup has no stores section.');
  if (errors.length) return { ok: false, errors, warnings };
  // Backups made before recurring transactions existed (version 1) have no 'recurring' store.
  if (b.backupVersion < 2 && b.stores.recurring === undefined) b.stores.recurring = [];
  // …and before contracts existed (versions 1–2) no 'contracts' / 'clauses' stores.
  if (b.backupVersion < 3) for (const s of ['contracts', 'clauses']) if (b.stores[s] === undefined) b.stores[s] = [];
  // …and before acquisition sources existed (versions 1–4) no 'sources' store.
  if (b.backupVersion < 5 && b.stores.sources === undefined) b.stores.sources = [];
  // …and before attachments existed (versions 1–6) no 'attachments' store and no files.
  if (b.backupVersion < 7 && b.stores.attachments === undefined) b.stores.attachments = [];
  // Version 3 kept dates and amounts on the contract; they move to clauses as in the v4 database upgrade.
  if (b.backupVersion === 3 && Array.isArray(b.stores.contracts) && Array.isArray(b.stores.clauses)) {
    const out = convertV3Contracts(b.stores.contracts, b.stores.clauses, b.nextIds?.clauses || 1);
    b.stores.contracts = out.contracts; b.stores.clauses = out.clauses;
    if (b.nextIds && typeof b.nextIds === 'object') b.nextIds.clauses = out.nextClauseId;
  }
  const v = validateDataset(b.stores, { strictMoney: true, allowMeta: true, allowUnknown: false });
  errors.push(...v.errors); warnings.push(...v.warnings);
  const extra = Object.keys(b.stores).filter((k) => !STORE_NAMES.includes(k));
  if (extra.length) errors.push('Unknown stores in backup: ' + extra.join(', '));
  const settings = validSettings(b.settings, errors);
  const nextIds = {};
  if (b.nextIds && typeof b.nextIds === 'object') for (const s of STORE_NAMES) { const n = b.nextIds[s]; if (n !== undefined) { if (Number.isSafeInteger(n) && n > 0) nextIds[s] = n; else errors.push(`nextIds.${s} is invalid`); } }
  // Attachment contents: one data URL per attachment description.
  const files = [];
  if (b.files !== undefined && !Array.isArray(b.files)) errors.push('files must be a list');
  else {
    const want = new Set((Array.isArray(b.stores.attachments) ? b.stores.attachments : []).map((a) => a.AttachmentID));
    for (const x of b.files || []) {
      if (!x || !want.has(x.AttachmentID) || typeof x.dataUrl !== 'string' || !/^data:[^,]*,/.test(x.dataUrl)) { errors.push(`files: entry for attachment ${x?.AttachmentID} is invalid or has no matching attachment`); continue; }
      files.push(x); want.delete(x.AttachmentID);
    }
    if (want.size) errors.push(`files: the contents of attachment(s) ${[...want].join(', ')} are missing`);
  }
  const counts = Object.fromEntries(STORE_NAMES.map((s) => [s, Array.isArray(b.stores[s]) ? b.stores[s].length : 0]));
  return { ok: errors.length === 0, errors, warnings, counts, exportedAt: b.exportedAt, appVersion: b.appVersion, data: { stores: b.stores, nextIds, settings, files } };
}

export async function restoreParsed(db, parsed, opts = {}) {
  if (!parsed?.ok) throw new Error('Refusing to restore an invalid backup.');
  const files = (parsed.data.files || []).map((x) => ({ AttachmentID: x.AttachmentID, blob: dataUrlToBlob(x.dataUrl) }));
  await db.replaceAll(parsed.data.stores, { nextIds: parsed.data.nextIds, settings: parsed.data.settings, files, ...opts });
}
