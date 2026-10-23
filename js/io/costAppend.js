// "Add costs from file": appends tblProjectCosts rows from an Access-export-shaped file to the existing
// records, without replacing anything. Each source cost is mapped to an existing project by
// client name + project name (case/space-insensitive); unmatched projects are chosen by the user.
import { ACCESS_FORMAT } from '../model/schema.js';
import { checkFieldType } from '../model/validate.js';
import { STORES } from '../model/schema.js';
import { Dec } from '../lib/decimal.js';

const norm = (s) => String(s ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const COST_FIELDS = ['StartDate', 'EndDate', 'CostItem', 'CostAmount', 'CostNotes'];

export function parseCostAppend(text, ds) {
  const errors = [];
  let src;
  try { src = JSON.parse(text); } catch (e) { return { ok: false, errors: ['The file is not valid JSON: ' + e.message] }; }
  if (!src || src.format !== ACCESS_FORMAT || !src.tables) return { ok: false, errors: ['Expected an Access export file (format "engineeredplans-access-export").'] };
  const costs = src.tables.tblProjectCosts, sProjects = src.tables.tblProjects || [], sClients = src.tables.tblClients || [];
  if (!Array.isArray(costs) || !costs.length) return { ok: false, errors: ['The file contains no tblProjectCosts rows.'] };
  const sClientById = new Map(sClients.map((c) => [c.ClientID, c]));
  const sProjById = new Map(sProjects.map((p) => [p.ProjectID, p]));

  // Existing projects by "client / project"
  const clientName = new Map(ds.clients.map((c) => [c.ClientID, c.ClientName]));
  const targets = new Map();
  for (const p of ds.projects) targets.set(`${norm(clientName.get(p.ClientID))}|${norm(p.ProjectName)}`, p.ProjectID);

  const rows = [];
  const sources = new Map(); // source ProjectID -> { label, count, total, match }
  costs.forEach((c, i) => {
    const r = {};
    for (const k of COST_FIELDS) {
      let v = c[k] === undefined ? null : c[k];
      if (k === 'CostAmount' && typeof v === 'string' && /^-?\d+(\.\d{1,4})?$/.test(v)) v = Dec.from(v).toFixed(4);
      const e = checkFieldType(STORES.costs.fields[k], v, { strictMoney: true });
      if (e) errors.push(`Cost row ${i + 1} (CostID ${c.CostID ?? '?'}): ${k} ${e}`);
      r[k] = v;
    }
    const sp = sProjById.get(c.ProjectID);
    if (!sources.has(c.ProjectID)) {
      const cl = sp ? sClientById.get(sp.ClientID) : null;
      const label = sp ? `${cl?.ClientName ?? `client #${sp.ClientID}`} / ${sp.ProjectName}` : `source project #${c.ProjectID}`;
      const match = sp ? targets.get(`${norm(cl?.ClientName)}|${norm(sp.ProjectName)}`) ?? null : null;
      sources.set(c.ProjectID, { sourceProjectId: c.ProjectID, label, count: 0, total: Dec.zero(), match });
    }
    const s = sources.get(c.ProjectID);
    s.count++;
    if (typeof r.CostAmount === 'string') s.total = s.total.add(r.CostAmount);
    rows.push({ sourceCostId: c.CostID ?? null, sourceProjectId: c.ProjectID, record: r });
  });
  return { ok: errors.length === 0, errors, rows, sources: [...sources.values()] };
}

const sameCost = (a, b) => a.ProjectID === b.ProjectID && COST_FIELDS.every((k) => (a[k] ?? null) === (b[k] ?? null));

// mapping: Map(sourceProjectId -> target ProjectID). Returns records to add and exact duplicates skipped.
export function planCostAppend(parsed, mapping, ds) {
  const toAdd = [], duplicates = [];
  for (const row of parsed.rows) {
    const rec = { ...row.record, ProjectID: mapping.get(row.sourceProjectId) };
    if (ds.costs.some((c) => sameCost(c, rec))) duplicates.push(row); else toAdd.push(rec);
  }
  return { toAdd, duplicates };
}
