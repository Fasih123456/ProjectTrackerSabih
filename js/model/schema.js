// Business stores. Field names deliberately keep the original Access names, so the
// store <-> table mapping below is the complete bidirectional mapping for import/export.
// Field types: id, fk, text, bool, enum, money (4-decimal string), number (Access Double), rate (fraction 0..1 Double), date.

export const DB_NAME = 'engineeredplans_project_tracker';
export const DEMO_DB_NAME = 'engineeredplans_project_tracker_demo';
export const DB_VERSION = 7;
export const APP_VERSION = '1.7.0';
export const BACKUP_FORMAT = 'engineeredplans-project-tracker-backup';
// v2 adds the 'recurring' store, v3 'contracts' and 'clauses', v4 moves contract dates/amounts onto clauses,
// v5 adds 'sources' (client acquisition sources, e.g. Fiverr) and the client field SourceID,
// v6 adds multi-currency fields on income, costs and recurring rules (see js/calc/fx.js) and the 'fxRates' cache,
// v7 adds 'attachments' (receipts on costs, invoices on income; file contents in the 'files' support store).
// Older backups are still accepted (v3 contracts are converted on restore).
export const BACKUP_VERSION = 7;
export const ACCESS_FORMAT = 'engineeredplans-access-export';

const f = (type, opts = {}) => ({ type, nullable: false, ...opts });
const n = (type, opts = {}) => ({ type, nullable: true, ...opts });
// Multi-currency fields of income and cost records (v6; blank = the base currency). See js/calc/fx.js.
const FX_LOCAL = { Currency: n('text', { max: 3 }), OriginalAmount: n('money'), FxRate: n('number'), FxDate: n('date'), FxStatus: n('enum', { values: ['final', 'provisional', 'manual'] }) };

export const STORES = {
  clients: {
    table: 'tblClients', key: 'ClientID', label: 'Clients', singular: 'client',
    fields: { ClientID: f('id'), ClientName: f('text', { max: 120 }), IsInternal: f('bool') },
    // Contact details (tracker-only). Shown as "{ClientName} - {CompanyName}" wherever a client is named.
    // SourceID: where the client came from (sources store; blank = not recorded).
    local: { Archived: n('bool'), CompanyName: n('text', { max: 160 }), Website: n('text', { max: 300 }), Phone: n('text', { max: 60 }), Email: n('text', { max: 200 }), SourceID: n('number') },
    indexes: [],
  },
  projects: {
    table: 'tblProjects', key: 'ProjectID', label: 'Projects', singular: 'project',
    fields: { ProjectID: f('id'), ClientID: f('fk', { ref: 'clients' }), ProjectName: f('text', { max: 160 }), ProjectType: f('enum', { values: ['Client', 'Internal'] }) },
    local: { CategoryCode: n('text'), Archived: n('bool') },
    indexes: ['ClientID'],
  },
  people: {
    table: 'tblPeople', key: 'PersonID', label: 'People', singular: 'employee',
    fields: { PersonID: f('id'), PersonName: f('text', { max: 120 }), MonthlyReferenceValue: n('money'), ReferenceHours: n('number'), RateNotes: n('text'), BankName: n('text'), AccountName: n('text'), IBAN: n('text') },
    // MonthlyReferenceValue is the monthly salary (Access name kept). Salary is paid from JoinDate to LeaveDate
    // (inclusive) through a linked recurring rule, charged to SalaryCategory ('TEAM_SALARIES' when null, or 'OWNERS_SALARY').
    // IsOwner: the company owner — no join/leave date and no automatic salary entries (owner salary is recorded by hand).
    local: { Archived: n('bool'), JoinDate: n('date'), LeaveDate: n('date'), SalaryCategory: n('text'), IsOwner: n('bool') },
    indexes: [],
  },
  salespeople: {
    table: 'tblSalespeople', key: 'SalespersonID', label: 'Salespeople', singular: 'salesperson',
    fields: { SalespersonID: f('id'), PersonID: f('fk', { ref: 'people' }), CloseRate: n('rate'), MeetingFee: n('money') },
    local: { Archived: n('bool') },
    indexes: ['PersonID'],
  },
  income: {
    table: 'tblProjectIncome', key: 'IncomeID', label: 'Project Income', singular: 'income record',
    fields: { IncomeID: f('id'), ProjectID: f('fk', { ref: 'projects' }), StartDate: f('date'), EndDate: n('date'), AmountPaid: f('money'), IncomeNotes: n('text') },
    local: { RecurringID: n('number'), ...FX_LOCAL },
    indexes: ['ProjectID', 'StartDate'],
  },
  timeEntries: {
    table: 'tblTimeEntries', key: 'TimeEntryID', label: 'Time Entries', singular: 'time entry',
    fields: { TimeEntryID: f('id'), WorkDate: f('date'), ProjectID: f('fk', { ref: 'projects' }), PersonID: f('fk', { ref: 'people' }), WorkTask: n('text'), HoursWorked: n('number'), HoursBilled: n('number'), RateOverride: n('money') },
    local: {},
    indexes: ['ProjectID', 'PersonID', 'WorkDate'],
  },
  costs: {
    table: 'tblProjectCosts', key: 'CostID', label: 'Project Costs', singular: 'cost',
    fields: { CostID: f('id'), StartDate: f('date'), EndDate: n('date'), ProjectID: f('fk', { ref: 'projects' }), CostItem: n('text'), CostAmount: f('money'), CostNotes: n('text') },
    local: { RecurringID: n('number'), ...FX_LOCAL },
    indexes: ['ProjectID', 'StartDate'],
  },
  activities: {
    table: 'tblSalesActivities', key: 'ActivityID', label: 'Employee Activities', singular: 'employee activity',
    fields: { ActivityID: f('id'), ActivityDate: f('date'), ProjectID: f('fk', { ref: 'projects' }), SalespersonID: f('fk', { ref: 'salespeople' }), ActivityType: f('text'), LeadNotes: n('text'), PaidAmountCredited: n('money'), BaseOverride: n('money'), CloseRateOverride: n('rate'), MeetingFeeOverride: n('money'), CommissionPaid: n('money') },
    local: {},
    indexes: ['ProjectID', 'SalespersonID', 'ActivityDate'],
  },
  payouts: {
    table: 'tblSalesPayouts', key: 'PayoutID', label: 'Sales Payouts', singular: 'payout',
    fields: { PayoutID: f('id'), SalespersonID: f('fk', { ref: 'salespeople' }), PayoutDate: f('date'), AmountPaid: f('money'), PayoutNotes: n('text') },
    local: {},
    indexes: ['SalespersonID', 'PayoutDate'],
  },
  acquisitions: {
    table: 'tblClientAcquisitions', key: 'AcquisitionID', label: 'Client Acquisitions', singular: 'client acquisition',
    fields: { AcquisitionID: f('id'), ClientID: f('fk', { ref: 'clients' }), SalespersonID: f('fk', { ref: 'salespeople' }), AcquisitionDate: f('date'), AcquisitionRate: f('rate'), AcquisitionNotes: n('text') },
    local: {},
    indexes: ['SalespersonID', 'AcquisitionDate'],
    unique: ['ClientID'],
  },
  // Local-only store (not part of the Access tables). Each rule creates ordinary income/cost records,
  // never more than two weeks (14 days) ahead. GeneratedThrough = date of the last occurrence already created
  // (maintained by the generator; the editor never changes it).
  recurring: {
    table: 'tblRecurring', localOnly: true, key: 'RecurringID', label: 'Recurring Transactions', singular: 'recurring transaction',
    fields: { RecurringID: f('id'), Kind: f('enum', { values: ['Income', 'Cost'] }), ProjectID: f('fk', { ref: 'projects' }), Name: f('text', { max: 160 }), Amount: f('money'), StartDate: f('date'), EndDate: n('date'), IntervalCount: f('number'), IntervalUnit: f('enum', { values: ['day', 'week', 'month', 'year'] }), Notes: n('text') },
    // Proration: no longer used (every occurrence is a full period); kept so older records and backups still load.
    // SplitProjects: extra project IDs ("4,7") that share a cost rule equally with ProjectID.
    // Schedule 'salary' + PersonID: an employee's salary rule, kept in step with the employee record (see recurring.js).
    local: { Currency: n('text', { max: 3 }), GeneratedThrough: n('date'), Proration: n('text'), Archived: n('bool'), SplitProjects: n('text'), Schedule: n('text'), PersonID: n('number') },
    indexes: ['ProjectID'],
  },
  // Local-only: client contracts. A contract only groups clauses; it is Active while at least one of its clauses is.
  // ProjectIDs: the client's projects it covers ("4,7"); a project whose contracts have all ended is hidden like an
  // archived project.
  contracts: {
    table: 'tblContracts', localOnly: true, key: 'ContractID', label: 'Contracts', singular: 'contract',
    fields: { ContractID: f('id'), ClientID: f('fk', { ref: 'clients' }), ContractName: f('text', { max: 160 }), ContractNotes: n('text') },
    local: { ProjectIDs: n('text') },
    indexes: ['ClientID'],
  },
  // Local-only: the clauses of a contract. Each runs from StartDate for TermYears + TermMonths (blank = until
  // cancelled); its end date is calculated, never stored. The renewal notice period is how long before the end date
  // the client's approval is needed. CostToEngineeredPlans = what Engineered Plans is charged, ChargeToClient = what the client pays.
  clauses: {
    table: 'tblContractClauses', localOnly: true, key: 'ClauseID', label: 'Contract Clauses', singular: 'contract clause',
    fields: { ClauseID: f('id'), ContractID: f('fk', { ref: 'contracts' }), ClauseTitle: f('text', { max: 200 }), ClauseDetails: n('text'), CostToEngineeredPlans: n('money'), ChargeToClient: n('money'), StartDate: f('date'), TermYears: n('number'), TermMonths: n('number'), RenewalNoticeCount: n('number'), RenewalNoticeUnit: n('enum', { values: ['week', 'month'] }) },
    local: {},
    indexes: ['ContractID'],
  },
  // Local-only: where clients come from (e.g. Fiverr, Upwork, Referral). Clients point here through SourceID.
  sources: {
    table: 'tblAcquisitionSources', localOnly: true, key: 'SourceID', label: 'Acquisition Sources', singular: 'acquisition source',
    fields: { SourceID: f('id'), SourceName: f('text', { max: 120 }), SourceNotes: n('text') },
    local: { Archived: n('bool') },
    indexes: [],
  },
  // Local-only: files attached to an income record (invoices) or a cost record (receipts). This is the file's
  // description; its contents (a Blob) are in the 'files' support store under the same AttachmentID, and are
  // written into backups as base64. Deleting the income/cost record deletes its attachments.
  attachments: {
    table: 'tblAttachments', localOnly: true, key: 'AttachmentID', label: 'Attachments', singular: 'attachment',
    fields: { AttachmentID: f('id'), Store: f('enum', { values: ['income', 'costs'] }), RecordID: f('number'), FileName: f('text', { max: 255 }), MimeType: f('text', { max: 120 }), Size: f('number') },
    local: {},
    indexes: ['RecordID'],
  },
};
export const MAX_ATTACHMENT_BYTES = 15 * 1024 * 1024; // per file
export const NOTICE_UNITS = ['week', 'month'];

export const STORE_NAMES = Object.keys(STORES);
export const ACCESS_STORE_NAMES = STORE_NAMES.filter((s) => !STORES[s].localOnly); // the ten original Access tables
export const TABLE_TO_STORE = Object.fromEntries(STORE_NAMES.map((s) => [STORES[s].table, s]));
export const STORE_TO_TABLE = Object.fromEntries(STORE_NAMES.map((s) => [s, STORES[s].table]));
export const RECURRING_UNITS = ['day', 'week', 'month', 'year'];
export const META_FIELDS = ['createdAt', 'updatedAt', 'revision'];

// Parent -> dependent references, used for delete protection.
export const DEPENDENTS = {};
for (const s of STORE_NAMES) {
  for (const [field, def] of Object.entries(STORES[s].fields)) {
    if (def.type === 'fk') (DEPENDENTS[def.ref] ||= []).push({ store: s, field });
  }
}

export const ACTIVITY_TYPES = ['Close', 'Attended meeting'];
export const PROJECT_TYPES = ['Client', 'Internal'];

// Stable company cost-centre codes. Renaming a project never changes its category.
export const COST_CATEGORIES = [
  { code: 'BANK_FEES', name: 'Bank Fees' },
  { code: 'CLIENT_ACQUISITION', name: 'Client Acquisition' },
  { code: 'EQUIPMENT_COST', name: 'Equipment Cost' },
  { code: 'OPERATIONS_COST', name: 'Operations Cost' },
  { code: 'TEAM_SALARIES', name: 'Team Salaries' },
  { code: 'OWNERS_SALARY', name: 'Owners Salary' },
];
export const CATEGORY_BY_CODE = Object.fromEntries(COST_CATEGORIES.map((c) => [c.code, c]));
export const CATEGORY_CODE_BY_NAME = Object.fromEntries(COST_CATEGORIES.map((c) => [c.name, c.code]));

// Internal setup created once in the first schema upgrade of a fresh database.
export const INTERNAL_SETUP = {
  client: { ClientID: 1, ClientName: 'Internal', IsInternal: true, Archived: null },
  projects: COST_CATEGORIES.map((c, i) => ({ ProjectID: i + 1, ClientID: 1, ProjectName: c.name, ProjectType: 'Internal', CategoryCode: c.code, Archived: null })),
};

// Blank record with every original + local field present (nulls kept distinct from zero).
export function blankRecord(store) {
  const def = STORES[store];
  const r = {};
  for (const [k, d] of Object.entries(def.fields)) r[k] = d.type === 'bool' ? false : null;
  for (const k of Object.keys(def.local)) r[k] = null;
  return r;
}
