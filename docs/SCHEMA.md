# Database schema and migrations

IndexedDB database: `engineeredplans_project_tracker` (demo: `engineeredplans_project_tracker_demo`; tests: `engineeredplans_test_*`). Current schema version: **1** (`DB_VERSION` in `js/model/schema.js`).

## Stores and Access mapping

Field names are the original Access names, so the store ↔ table mapping below is the complete bidirectional mapping used for import and export. Every business record also carries the local metadata fields `createdAt` and `updatedAt` (ISO timestamps) and `revision` (an integer that increases with each edit and is used for stale-edit detection).

| Store | Access table | Key | Fields (type) | Local fields | Indexes |
| --- | --- | --- | --- | --- | --- |
| clients | tblClients | ClientID | ClientName (text ≤120), IsInternal (bool) | Archived | — |
| projects | tblProjects | ProjectID | ClientID (FK clients), ProjectName (text ≤160), ProjectType (`Client`/`Internal`) | CategoryCode, Archived | ClientID |
| people | tblPeople | PersonID | PersonName, MonthlyReferenceValue (money?), ReferenceHours (number?), RateNotes?, BankName?, AccountName?, IBAN? | Archived, JoinDate?, LeaveDate? (inclusive), SalaryCategory? (`TEAM_SALARIES` when null, or `OWNERS_SALARY`). MonthlyReferenceValue is the monthly salary. | — |
| salespeople | tblSalespeople | SalespersonID | PersonID (FK people), CloseRate (fraction?), MeetingFee (money?) | Archived | PersonID |
| income | tblProjectIncome | IncomeID | ProjectID (FK), StartDate, EndDate?, AmountPaid (money), IncomeNotes? | — | ProjectID, StartDate |
| timeEntries | tblTimeEntries | TimeEntryID | WorkDate, ProjectID (FK), PersonID (FK), WorkTask?, HoursWorked?, HoursBilled?, RateOverride (money/hour?) | — | ProjectID, PersonID, WorkDate |
| costs | tblProjectCosts | CostID | StartDate, EndDate?, ProjectID (FK), CostItem?, CostAmount (money), CostNotes? | — | ProjectID, StartDate |
| activities | tblSalesActivities | ActivityID | ActivityDate, ProjectID (FK), SalespersonID (FK), ActivityType, LeadNotes?, PaidAmountCredited?, BaseOverride?, CloseRateOverride (fraction?), MeetingFeeOverride?, CommissionPaid? (legacy) | — | ProjectID, SalespersonID, ActivityDate |
| payouts | tblSalesPayouts | PayoutID | SalespersonID (FK), PayoutDate, AmountPaid (money), PayoutNotes? | — | SalespersonID, PayoutDate |
| acquisitions | tblClientAcquisitions | AcquisitionID | ClientID (FK, **unique**), SalespersonID (FK), AcquisitionDate, AcquisitionRate (fraction), AcquisitionNotes? | — | ClientID (unique), SalespersonID, AcquisitionDate |

| recurring *(v2, tracker-only)* | tblRecurring | RecurringID | Kind (`Income`/`Cost`), ProjectID (FK), Name (text ≤160), Amount (money > 0), StartDate, EndDate?, IntervalCount (whole number 1–999), IntervalUnit (`day`/`week`/`month`/`year`), Notes? | GeneratedThrough (date of the last occurrence created; set only by the generator), Archived (= paused), Proration? (no longer used: every occurrence is a full period), SplitProjects?, Schedule? (`salary` = paid at each month end, every month worked in full), PersonID? (the employee a salary rule belongs to; kept in step on every employee save) | ProjectID |

| sources *(v5, tracker-only)* | tblAcquisitionSources | SourceID | SourceName (text ≤120, unique ignoring case), SourceNotes? | Archived | — |

`clients` also has the local field `SourceID` (nullable, v5): the client's acquisition source. It is checked on save and on restore, and a source that clients use cannot be deleted (archive it instead). `sources` is not part of the Access export.

`income` and `costs` also have the local field `RecurringID` (nullable), which links a generated record to its rule. It is not a foreign key: deleting a rule keeps the records it already created. `tblRecurring` is not part of the Access export and is empty after an Access import.

`?` = nullable. Null is kept distinct from zero everywhere.

Value encodings:

- **money**: decimal string with exactly four decimals (for example `"320000.0000"`), matching Access Currency. It is never a JS float.
- **number / fraction**: JS number (Access Double). Rates are fractions (5% = `0.05`).
- **date**: `YYYY-MM-DD` string.

Support stores:

- `meta` (keyPath `key`): `nextIds` (next ID per store; always above the current maximum, so IDs are never reused), `setup` (when the internal setup was created), `lastBackupAt`.
- `settings` (keyPath `key`): `logo` (`{dataUrl, name, updatedAt}`), included in backups.

`CategoryCode` values: `BANK_FEES`, `CLIENT_ACQUISITION`, `EQUIPMENT_COST`, `OPERATIONS_COST`, `TEAM_SALARIES`, `OWNERS_SALARY`, or null (Other Internal Costs). Only `Internal` projects may have a code.

## Integrity rules

IndexedDB does not enforce these, so the app checks them inside each write transaction (`js/storage/db.js` + `js/model/validate.js`):

- Foreign keys must exist when a record is created or edited.
- A parent with dependent records cannot be deleted. The app shows the dependants and offers Archive for clients, projects, employees and salespeople. There is no cascade delete.
- There is one acquisition per client (a unique index), and acquisitions are never allowed for an internal client. There is one sales profile per employee.
- A project's type must match its client (internal client → Internal).
- Dates must be valid; End Date ≥ Start Date; hours and amounts must be ≥ 0; rates must be in [0, 1]; payouts must be > 0; reference hours must be > 0.
- When an existing record is edited, a rule is re-checked only if a field it depends on changed. This lets imported anomalies be reported in Data Quality instead of blocking unrelated edits.
- An update or delete is refused when the stored `revision` differs from the one the editor loaded (the record was changed in another tab). Committed changes are broadcast on a `BroadcastChannel` so other open tabs refresh.

## Migrations

`MIGRATIONS[v]` in `js/storage/db.js` runs once per version, inside the `versionchange` transaction.

- **v1**: creates the ten business stores with their indexes, plus `meta` and `settings`. It seeds the internal client (ClientID 1) and the six cost centres (ProjectID 1–6 with category codes) exactly once, together with `nextIds`.

- **v7**: attachments. Creates the `attachments` store (tracker-only, key `AttachmentID`: `Store` = `income` (invoices) or `costs` (receipts), `RecordID`, `FileName`, `MimeType`, `Size`; index `RecordID`) and the `files` support store (`{ AttachmentID, blob }`, the file contents). Deleting an income/cost record deletes its attachments in the same transaction. Generated recurring entries that have attachments count as edited by hand: the automatic clean-ups (two-week window, end-date changes) and "Save & update old entries" never delete or rewrite them. Backups use `backupVersion` 7 and add a top-level `files` list (`{ AttachmentID, dataUrl }`, base64) that must cover every attachment; older backups are still accepted.

- **v6**: multi-currency. Creates the `fxRates` support store (keyPath `date`: one day of mid-market rates per 1 USD, `{ date, rates, fetchedAt, source }`; a re-downloadable cache, not in backups). `income` and `costs` get the local fields `Currency` (3-letter code; blank = PKR), `OriginalAmount` (money, in that currency), `FxRate` (PKR per 1 unit), `FxDate` (the day of that rate) and `FxStatus` (`final` = rate of the record's own date, `provisional` = stand-in until that day's rate is published, replaced by the background job; `manual` = actual rate received, never changed automatically). `AmountPaid` / `CostAmount` always hold the PKR amount (`OriginalAmount × FxRate`, 4 decimals), so all totals stay in PKR. `recurring` gets `Currency`; its `Amount` is then in that currency. Existing records are untouched (PKR). Settings gain `currencies` (enabled codes). Backups use `backupVersion` 6; older backups are still accepted.

- **v5**: creates the `sources` store (client acquisition sources). Existing clients are untouched and have no source until one is chosen. Backups now use `backupVersion` 5; older backups (without `sources`) are still accepted.

- **v2**: creates the `recurring` store (index `ProjectID`). Nothing else changes, and existing records are untouched. Backups now use `backupVersion` 2; version-1 backups (without `recurring`) are still accepted.

Recurring generation (`TrackerDB.generateRecurring(today)`) runs in a single transaction. For every rule that is not archived, it creates the occurrences after `GeneratedThrough` whose date is strictly before `today + 1 month` (and on or before EndDate), then advances `GeneratedThrough` without changing the rule's revision.

To add version *n*: increase `DB_VERSION` and add `MIGRATIONS[n]`, which may only **create** stores or indexes, or transform records in place. Never delete a database, clear stores, or recreate stores in a migration. Other tabs are closed through `onversionchange` and asked to reload. A blocked upgrade shows a message instead of forcing anything.

## Backup file format (`backupVersion` 1)

```json
{ "format": "engineeredplans-project-tracker-backup", "backupVersion": 1, "schemaVersion": 1, "appVersion": "1.0.0",
  "exportedAt": "…", "currency": "PKR", "tableNames": {…}, "counts": {…}, "nextIds": {…}, "settings": {…},
  "stores": { "clients": [ … ], …all ten… } }
```

A restore rejects: files that are not valid JSON; other formats; newer `backupVersion` or `schemaVersion`; missing stores or fields; wrong field types; money that is not a 4-decimal string; duplicate IDs; missing references; duplicate unique values; and unknown fields. The access-export format (`engineeredplans-access-export`) is handled only by *Import Access export*.
