import { STORES, STORE_NAMES, META_FIELDS, ACTIVITY_TYPES, PROJECT_TYPES, CATEGORY_BY_CODE } from './schema.js';
import { isValidISODate } from '../lib/dates.js';
import { Dec } from '../lib/decimal.js';
import { CURRENCY_RE, isForeign } from '../calc/fx.js';
import { parseIdList, SALARY_CATEGORIES, paysSalary, salaryProjectId } from '../calc/recurring.js';

const MONEY_RE = /^-?\d+(\.\d{1,4})?$/;
const MONEY4_RE = /^-?\d+\.\d{4}$/;

// ---------- structural type checks (import / restore) ----------

// Returns an error message or null. `strictMoney` requires exactly 4 decimals (own backups).
export function checkFieldType(def, v, { strictMoney = false } = {}) {
  if (v === null || v === undefined) {
    if (def.type === 'bool' && !def.nullable) return 'must be true/false';
    return def.nullable ? null : 'is required';
  }
  switch (def.type) {
    case 'id': case 'fk': return Number.isSafeInteger(v) && v > 0 ? null : 'must be a positive whole number';
    case 'text': case 'enum':
      if (typeof v !== 'string') return 'must be text';
      if (def.max && v.length > def.max) return `is longer than ${def.max} characters`;
      return null;
    case 'bool': return typeof v === 'boolean' ? null : 'must be true/false';
    case 'money': return typeof v === 'string' && (strictMoney ? MONEY4_RE : MONEY_RE).test(v) ? null : 'must be a decimal string with up to 4 decimal places';
    case 'number': case 'rate': return typeof v === 'number' && Number.isFinite(v) ? null : 'must be a finite number';
    case 'date': return isValidISODate(v) ? null : 'must be a valid YYYY-MM-DD date';
    default: return 'has an unknown type';
  }
}

// Structural validation of a whole dataset {store: rows[]}. Returns {errors, warnings}.
export function validateDataset(ds, { allowUnknown = false, strictMoney = false, allowMeta = true } = {}) {
  const errors = [], warnings = [];
  const ids = {};
  for (const s of STORE_NAMES) {
    const def = STORES[s];
    const rows = ds[s];
    if (!Array.isArray(rows)) { errors.push(`${def.table}: missing table (expected a list of records)`); continue; }
    const known = new Set([...Object.keys(def.fields), ...Object.keys(def.local), ...(allowMeta ? META_FIELDS : [])]);
    ids[s] = new Set();
    rows.forEach((r, i) => {
      const where = `${def.table} row ${i + 1}${r && r[def.key] != null ? ` (${def.key} ${r[def.key]})` : ''}`;
      if (!r || typeof r !== 'object' || Array.isArray(r)) { errors.push(`${where}: not a record object`); return; }
      for (const [k, fd] of Object.entries(def.fields)) {
        if (!(k in r)) { errors.push(`${where}: field ${k} is missing`); continue; }
        const e = checkFieldType(fd, r[k], { strictMoney });
        if (e) errors.push(`${where}: ${k} ${e}`);
      }
      for (const [k, fd] of Object.entries(def.local)) if (k in r) { const e = checkFieldType(fd, r[k]); if (e) errors.push(`${where}: ${k} ${e}`); }
      if (allowMeta) {
        if ('revision' in r && !(Number.isSafeInteger(r.revision) && r.revision > 0)) errors.push(`${where}: revision must be a positive whole number`);
        for (const k of ['createdAt', 'updatedAt']) if (k in r && r[k] !== null && typeof r[k] !== 'string') errors.push(`${where}: ${k} must be text`);
      }
      for (const k of Object.keys(r)) if (!known.has(k)) (allowUnknown ? warnings : errors).push(`${where}: unknown field ${k}${allowUnknown ? ' (ignored)' : ''}`);
      const id = r[def.key];
      if (Number.isSafeInteger(id)) { if (ids[s].has(id)) errors.push(`${where}: duplicate ${def.key} ${id}`); ids[s].add(id); }
    });
  }
  if (errors.length) return { errors, warnings };
  // Foreign keys and unique constraints
  for (const s of STORE_NAMES) {
    const def = STORES[s];
    for (const [k, fd] of Object.entries(def.fields)) {
      if (fd.type !== 'fk') continue;
      for (const r of ds[s]) if (r[k] !== null && !ids[fd.ref].has(r[k])) errors.push(`${def.table} ${def.key} ${r[def.key]}: ${k} ${r[k]} does not exist in ${STORES[fd.ref].table}`);
    }
    for (const k of def.unique || []) {
      const seen = new Map();
      for (const r of ds[s]) { if (seen.has(r[k])) errors.push(`${def.table}: ${k} ${r[k]} appears more than once (must be unique)`); seen.set(r[k], true); }
    }
  }
  // Attachments belong to an income or cost record.
  const has = (store, id) => ids[store]?.has(id);
  for (const a of ds.attachments || []) if (!has(a.Store, a.RecordID)) errors.push(`tblAttachments AttachmentID ${a.AttachmentID}: ${a.Store} record ${a.RecordID} does not exist`);
  // Tracker-only reference: a client's acquisition source.
  for (const c of ds.clients) if (c.SourceID !== null && c.SourceID !== undefined && !ids.sources.has(c.SourceID)) errors.push(`tblClients ClientID ${c.ClientID}: SourceID ${c.SourceID} does not exist in tblAcquisitionSources`);
  return { errors, warnings };
}

// ---------- business rules for Submit (new and edited records) ----------

const blank = (v) => v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
const nonNeg = (v) => v === null || Dec.from(v).sign() >= 0;
const rate01 = (v) => v === null || (v >= 0 && v <= 1);
const dateOk = (v) => isValidISODate(v);
const wholeOrBlank = (v, max) => v === null || v === undefined || (Number.isInteger(v) && v >= 0 && v <= max);
// Multi-currency fields of income and costs (blank currency = the base currency; see js/calc/fx.js).
const FX_RULES = [
  ['Currency', ['Currency'], (r) => r.Currency === null || r.Currency === undefined || CURRENCY_RE.test(r.Currency) ? null : 'Choose a currency'],
  ['OriginalAmount', ['Currency', 'OriginalAmount'], (r) => !isForeign(r) ? null : r.OriginalAmount === null || r.OriginalAmount === undefined ? 'Enter the amount in ' + r.Currency : nonNeg(r.OriginalAmount) ? null : 'Must not be negative'],
  ['FxRate', ['Currency', 'FxRate'], (r) => !isForeign(r) ? null : Number.isFinite(r.FxRate) && r.FxRate > 0 ? null : 'The exchange rate must be greater than zero'],
];
const endOk = (r) => r.EndDate === null || (isValidISODate(r.EndDate) && r.EndDate >= r.StartDate);

// Each rule: [field shown, fields it depends on, check(rec, ctx) -> message|null]
const RULES = {
  clients: [
    ['ClientName', ['ClientName'], (r) => blank(r.ClientName) ? 'Enter a client name' : null],
    ['Email', ['Email'], (r) => blank(r.Email) || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(r.Email.trim()) ? null : 'Enter a valid email address, e.g. name@company.com'],
    ['Website', ['Website'], (r) => blank(r.Website) || /^(https?:\/\/)?[^\s/]+\.[^\s]+$/i.test(r.Website.trim()) ? null : 'Enter a website address, e.g. company.com'],
    ['SourceID', ['SourceID'], (r, c) => r.SourceID === null || r.SourceID === undefined || c.get('sources', r.SourceID) ? null : 'This acquisition source no longer exists'],
  ],
  attachments: [
    ['RecordID', ['Store', 'RecordID'], (r, c) => ['income', 'costs'].includes(r.Store) && c.get(r.Store, r.RecordID) ? null : 'The record this file belongs to no longer exists'],
    ['FileName', ['FileName'], (r) => blank(r.FileName) ? 'The file has no name' : null],
  ],
  sources: [
    ['SourceName', ['SourceName'], (r) => blank(r.SourceName) ? 'Enter a source name, e.g. Fiverr' : null],
    ['SourceName', ['SourceName'], (r, c) => c.all('sources').some((s) => s.SourceID !== r.SourceID && s.SourceName.trim().toLowerCase() === r.SourceName.trim().toLowerCase()) ? 'A source with this name already exists' : null],
  ],
  projects: [
    ['ClientID', ['ClientID'], (r, c) => c.get('clients', r.ClientID) ? null : 'Choose a client'],
    ['ProjectName', ['ProjectName'], (r) => blank(r.ProjectName) ? 'Enter a project name' : null],
    ['ProjectType', ['ProjectType'], (r) => PROJECT_TYPES.includes(r.ProjectType) ? null : 'Choose Client or Internal'],
    ['ProjectType', ['ProjectType', 'ClientID'], (r, c) => {
      const cl = c.get('clients', r.ClientID);
      if (!cl) return null;
      if (cl.IsInternal && r.ProjectType !== 'Internal') return 'Projects of an internal client must be type Internal';
      if (!cl.IsInternal && r.ProjectType !== 'Client') return 'Projects of a non-internal client must be type Client';
      return null;
    }],
    ['CategoryCode', ['CategoryCode', 'ProjectType'], (r) => {
      if (r.CategoryCode === null) return null;
      if (!CATEGORY_BY_CODE[r.CategoryCode]) return 'Unknown cost category';
      return r.ProjectType === 'Internal' ? null : 'Only internal projects can have a company cost category';
    }],
  ],
  people: [
    ['PersonName', ['PersonName'], (r) => blank(r.PersonName) ? 'Enter the employee name' : null],
    ['MonthlyReferenceValue', ['MonthlyReferenceValue'], (r) => r.MonthlyReferenceValue === null ? 'Enter a monthly salary (0 is allowed)' : nonNeg(r.MonthlyReferenceValue) ? null : 'Must not be negative'],
    ['ReferenceHours', ['ReferenceHours'], (r) => r.ReferenceHours === null ? 'Enter reference hours' : (Number.isFinite(r.ReferenceHours) && r.ReferenceHours > 0 ? null : 'Reference hours must be greater than zero')],
    ['JoinDate', ['JoinDate', 'IsOwner'], (r) => blank(r.JoinDate) ? (r.IsOwner ? null : 'Enter the join date') : dateOk(r.JoinDate) ? null : 'Enter a valid join date'],
    ['LeaveDate', ['JoinDate', 'LeaveDate'], (r) => blank(r.LeaveDate) || (dateOk(r.LeaveDate) && (!r.JoinDate || r.LeaveDate >= r.JoinDate)) ? null : 'Leave date must be on or after the join date'],
    ['SalaryCategory', ['SalaryCategory', 'JoinDate', 'MonthlyReferenceValue'], (r, c) => {
      if (!blank(r.SalaryCategory) && !SALARY_CATEGORIES.includes(r.SalaryCategory)) return 'Choose Team Salaries or Owners Salary';
      if (!paysSalary(r) || salaryProjectId(r, c.all('projects')) !== null) return null;
      return `There is no internal “${CATEGORY_BY_CODE[r.SalaryCategory || 'TEAM_SALARIES'].name}” cost centre to charge the salary to. Add one under Projects first.`;
    }],
  ],
  salespeople: [
    ['PersonID', ['PersonID'], (r, c) => c.get('people', r.PersonID) ? null : 'Choose an employee'],
    ['PersonID', ['PersonID'], (r, c) => c.all('salespeople').some((s) => s.PersonID === r.PersonID && s.SalespersonID !== r.SalespersonID) ? 'This employee already has a sales profile' : null],
    ['CloseRate', ['CloseRate'], (r) => r.CloseRate === null ? 'Enter a close rate (0% is allowed)' : rate01(r.CloseRate) ? null : 'Rate must be between 0% and 100%'],
    ['MeetingFee', ['MeetingFee'], (r) => r.MeetingFee === null ? 'Enter a meeting fee (0 is allowed)' : nonNeg(r.MeetingFee) ? null : 'Must not be negative'],
  ],
  income: [
    ['ProjectID', ['ProjectID'], (r, c) => c.get('projects', r.ProjectID) ? null : 'Choose a project'],
    ['StartDate', ['StartDate'], (r) => dateOk(r.StartDate) ? null : 'Enter a valid start date'],
    ['EndDate', ['StartDate', 'EndDate'], (r) => endOk(r) ? null : 'End date must be on or after the start date'],
    ['AmountPaid', ['AmountPaid'], (r) => r.AmountPaid === null ? 'Enter the amount paid' : nonNeg(r.AmountPaid) ? null : 'Must not be negative'],
    ...FX_RULES,
  ],
  timeEntries: [
    ['WorkDate', ['WorkDate'], (r) => dateOk(r.WorkDate) ? null : 'Enter a valid work date'],
    ['ProjectID', ['ProjectID'], (r, c) => c.get('projects', r.ProjectID) ? null : 'Choose a project'],
    ['PersonID', ['PersonID'], (r, c) => c.get('people', r.PersonID) ? null : 'Choose an employee'],
    ['HoursWorked', ['HoursWorked'], (r) => r.HoursWorked === null ? 'Enter hours worked (0 is allowed)' : r.HoursWorked >= 0 ? null : 'Must not be negative'],
    ['HoursBilled', ['HoursBilled'], (r) => r.HoursBilled === null ? 'Enter hours billed (0 is allowed)' : r.HoursBilled >= 0 ? null : 'Must not be negative'],
    ['RateOverride', ['RateOverride'], (r) => nonNeg(r.RateOverride) ? null : 'Must not be negative'],
  ],
  costs: [
    ['StartDate', ['StartDate'], (r) => dateOk(r.StartDate) ? null : 'Enter a valid start date'],
    ['EndDate', ['StartDate', 'EndDate'], (r) => endOk(r) ? null : 'End date must be on or after the start date'],
    ['ProjectID', ['ProjectID'], (r, c) => c.get('projects', r.ProjectID) ? null : 'Choose a project or cost centre'],
    ['CostAmount', ['CostAmount'], (r) => r.CostAmount === null ? 'Enter the cost amount' : nonNeg(r.CostAmount) ? null : 'Must not be negative'],
    ...FX_RULES,
  ],
  activities: [
    ['ActivityDate', ['ActivityDate'], (r) => dateOk(r.ActivityDate) ? null : 'Enter a valid activity date'],
    ['ProjectID', ['ProjectID'], (r, c) => c.get('projects', r.ProjectID) ? null : 'Choose a project'],
    ['SalespersonID', ['SalespersonID'], (r, c) => c.get('salespeople', r.SalespersonID) ? null : 'Choose a salesperson'],
    ['ActivityType', ['ActivityType'], (r) => ACTIVITY_TYPES.includes(r.ActivityType) ? null : 'Choose Close or Attended meeting'],
    ['PaidAmountCredited', ['PaidAmountCredited'], (r) => nonNeg(r.PaidAmountCredited) ? null : 'Must not be negative'],
    ['BaseOverride', ['BaseOverride'], (r) => nonNeg(r.BaseOverride) ? null : 'Must not be negative'],
    ['CloseRateOverride', ['CloseRateOverride'], (r) => rate01(r.CloseRateOverride) ? null : 'Rate must be between 0% and 100%'],
    ['MeetingFeeOverride', ['MeetingFeeOverride'], (r) => nonNeg(r.MeetingFeeOverride) ? null : 'Must not be negative'],
    ['CommissionPaid', ['CommissionPaid'], (r) => nonNeg(r.CommissionPaid) ? null : 'Must not be negative'],
  ],
  payouts: [
    ['SalespersonID', ['SalespersonID'], (r, c) => c.get('salespeople', r.SalespersonID) ? null : 'Choose a salesperson'],
    ['PayoutDate', ['PayoutDate'], (r) => dateOk(r.PayoutDate) ? null : 'Enter a valid payout date'],
    ['AmountPaid', ['AmountPaid'], (r) => r.AmountPaid !== null && Dec.from(r.AmountPaid).sign() > 0 ? null : 'Enter an amount greater than zero'],
  ],
  recurring: [
    ['Kind', ['Kind'], (r) => ['Income', 'Cost'].includes(r.Kind) ? null : 'Choose Income or Cost'],
    ['Currency', ['Currency'], (r) => r.Currency === null || r.Currency === undefined || CURRENCY_RE.test(r.Currency) ? null : 'Choose a currency'],
    ['Name', ['Name'], (r) => blank(r.Name) ? 'Enter a task / description name' : null],
    ['ProjectID', ['ProjectID'], (r, c) => c.get('projects', r.ProjectID) ? null : 'Choose a project'],
    ['Amount', ['Amount'], (r) => r.Amount !== null && Dec.from(r.Amount).sign() > 0 ? null : 'Enter an amount greater than zero'],
    ['StartDate', ['StartDate'], (r) => dateOk(r.StartDate) ? null : 'Enter a valid start date'],
    ['EndDate', ['StartDate', 'EndDate'], (r) => endOk(r) ? null : 'End date must be on or after the start date'],
    ['IntervalCount', ['IntervalCount'], (r) => Number.isInteger(r.IntervalCount) && r.IntervalCount >= 1 && r.IntervalCount <= 999 ? null : 'Enter a whole number from 1 to 999'],
    ['IntervalUnit', ['IntervalUnit'], (r) => ['day', 'week', 'month', 'year'].includes(r.IntervalUnit) ? null : 'Choose days, weeks, months or years'],
    ['SplitProjects', ['SplitProjects', 'Kind'], (r, c) => {
      if (r.SplitProjects === null || r.SplitProjects === undefined || r.SplitProjects === '') return null;
      if (r.Kind !== 'Cost') return 'Only costs can be split across projects';
      return parseIdList(r.SplitProjects).every((id) => c.get('projects', id)) ? null : 'One of the projects to split with no longer exists';
    }],
  ],
  contracts: [
    ['ClientID', ['ClientID'], (r, c) => c.get('clients', r.ClientID) ? null : 'Choose a client'],
    ['ContractName', ['ContractName'], (r) => blank(r.ContractName) ? 'Enter a contract name' : null],
    ['ProjectIDs', ['ProjectIDs', 'ClientID'], (r, c) => {
      for (const id of parseIdList(r.ProjectIDs)) {
        const p = c.get('projects', id);
        if (!p) return 'One of the projects no longer exists';
        if (p.ClientID !== r.ClientID) return 'Projects must belong to the contract’s client';
      }
      return null;
    }],
  ],
  clauses: [
    ['ContractID', ['ContractID'], (r, c) => c.get('contracts', r.ContractID) ? null : 'Choose a contract'],
    ['ClauseTitle', ['ClauseTitle'], (r) => blank(r.ClauseTitle) ? 'Enter the clause' : null],
    ['StartDate', ['StartDate'], (r) => dateOk(r.StartDate) ? null : 'Enter a valid start date'],
    ['TermYears', ['TermYears'], (r) => wholeOrBlank(r.TermYears, 99) ? null : 'Enter a whole number of years'],
    ['TermMonths', ['TermMonths'], (r) => wholeOrBlank(r.TermMonths, 1188) ? null : 'Enter a whole number of months'],
    ['RenewalNoticeCount', ['RenewalNoticeCount'], (r) => wholeOrBlank(r.RenewalNoticeCount, 999) ? null : 'Enter a whole number of weeks or months'],
    ['RenewalNoticeUnit', ['RenewalNoticeCount', 'RenewalNoticeUnit'], (r) => (r.RenewalNoticeCount === null || r.RenewalNoticeCount === undefined) === !r.RenewalNoticeUnit ? null : r.RenewalNoticeUnit ? 'Enter how many weeks or months' : 'Choose weeks or months'],
    ['CostToEngineeredPlans', ['CostToEngineeredPlans'], (r) => nonNeg(r.CostToEngineeredPlans ?? null) ? null : 'Must not be negative'],
    ['ChargeToClient', ['ChargeToClient'], (r) => nonNeg(r.ChargeToClient ?? null) ? null : 'Must not be negative'],
  ],
  acquisitions: [
    ['ClientID', ['ClientID'], (r, c) => { const cl = c.get('clients', r.ClientID); return !cl ? 'Choose a client' : cl.IsInternal ? 'Choose a real client, not an internal client' : null; }],
    ['ClientID', ['ClientID'], (r, c) => c.all('acquisitions').some((a) => a.ClientID === r.ClientID && a.AcquisitionID !== r.AcquisitionID) ? 'This client already has an acquisition record' : null],
    ['SalespersonID', ['SalespersonID'], (r, c) => c.get('salespeople', r.SalespersonID) ? null : 'Choose a salesperson'],
    ['AcquisitionDate', ['AcquisitionDate'], (r) => dateOk(r.AcquisitionDate) ? null : 'Enter a valid acquisition date'],
    ['AcquisitionRate', ['AcquisitionRate'], (r) => r.AcquisitionRate === null ? 'Enter the acquisition rate' : rate01(r.AcquisitionRate) ? null : 'Rate must be between 0% and 100%'],
  ],
};

const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);

// ctx: { get(store, id), all(store) }. On edit, a rule is re-checked only when a field it depends on
// changed, so imported anomalies are reported (Data Quality) instead of blocking unrelated edits.
export function validateRecord(store, rec, ctx, original = null) {
  const errs = {};
  const def = STORES[store];
  for (const [k, fd] of Object.entries(def.fields)) {
    if (fd.type === 'id') continue;
    if (original && same(rec[k], original[k])) continue;
    const e = checkFieldType(fd, rec[k], { strictMoney: true });
    if (e) errs[k] = errs[k] || `This field ${e}`;
  }
  if (Object.keys(errs).length) return errs;
  for (const [field, deps, check] of RULES[store] || []) {
    if (errs[field]) continue;
    if (original && deps.every((d) => same(rec[d], original[d]))) continue;
    const msg = check(rec, ctx);
    if (msg) errs[field] = msg;
  }
  return errs;
}

export function ctxFromDataset(ds) {
  const maps = {};
  return {
    get(store, id) {
      if (!maps[store]) maps[store] = new Map(ds[store].map((r) => [r[STORES[store].key], r]));
      return maps[store].get(id) || null;
    },
    all(store) { return ds[store]; },
  };
}
