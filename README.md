# Engineered Plans Project Tracker

A local, single-user business tracker for clients, projects, paid income, costs, employee time, sales commission, payouts and employee banking details. It replaces the old Microsoft Access tracker. Everything runs on this computer: there are no accounts, no cloud services and no online requests.

It starts with the internal client "Internal" and its six company cost centres (Bank Fees, Client Acquisition, Equipment Cost, Operations Cost, Team Salaries, Owners Salary), plus two sample clients with one project each so the screens are not empty. The samples are added only once, on the first start of an empty database; delete them or use **Reset all data** when you begin entering real records.

## Start and stop

| Action | How |
| --- | --- |
| **Start** | Double-click **`Start-Project-Tracker.bat`**. A console window opens and your browser opens **http://localhost:4173**. Keep that window open while you work. |
| **Stop** | Close the console window, press **Ctrl+C** in it, or double-click **`Stop-Project-Tracker.bat`**. |
| **Open again later** | Run `Start-Project-Tracker.bat` again, or bookmark **http://localhost:4173** (it only works while the server window is running). |

- Requirements: Windows 10/11 with Windows PowerShell (built in), plus Microsoft Edge or Google Chrome. Nothing needs installing and no internet connection is needed.
- The address is always **http://localhost:4173**. The server only listens on this computer (loopback), not on your network.
- If port 4173 is already used by another program, the launcher explains the conflict and stops. It never switches to another port, because a different address would show a different, empty tracker.
- Do **not** open `index.html` directly (a `file://` address). Always use the launcher.

## Where your data lives

- Records are stored in your browser's **IndexedDB** database named `engineeredplans_project_tracker`, inside your browser profile, for the origin `http://localhost:4173`.
- Records are saved the moment you press **Submit**. The success message appears only after the browser confirms the save. **Cancel** and leaving a screen never save anything.
- Closing the tab or the browser, stopping the server, restarting the computer and updating the app **do not erase records**.
- On first start the app asks the browser for **persistent storage**. Settings & Backup shows whether this was granted (Persistent, Best-effort or Unavailable), roughly how much space is used, and when you last exported a backup.

### What can lose data

IndexedDB is reliable but not indestructible. You can lose records if you:

- clear browsing data / site data / cookies for localhost, or reset the browser;
- use a private/InPrivate/Incognito window (its storage is deleted when it closes);
- use a different browser, a different browser profile, or a different address (for example `127.0.0.1:4173` or another port is a *separate, empty* store);
- lose or replace the computer, or delete the Windows user profile;
- run with "Best-effort" storage while the disk is almost full (the browser may evict data).

Data is **not** shared between browsers or computers automatically.

## Backups (do this weekly)

- Click **Backup** in the header (or Settings & Backup → *Export full backup*). The browser downloads a file such as `engineeredplans-tracker-backup_2026-09-30_1430.json` to your Downloads folder. Copy it somewhere safe (a USB drive or another disk).
- The backup contains every record in all ten stores with original IDs, blank (null) values, four-decimal amounts and relationships, plus settings and any custom logo.
- A reminder appears when there are records and the last backup is more than 7 days old. Browsers cannot silently save files to a folder, so backups are manual downloads.

### Restore

Settings & Backup → **Restore backup** → choose the file. The whole file is checked first (format, version, field types, unique IDs, references). You see a preview of record counts and are offered a backup of your current data. The replacement happens in a single all-or-nothing step: if anything fails, your current data stays exactly as it was. Backups from a newer, unsupported app version are refused. Replacement is disabled while you have unsaved edits.

### Reset all data

Settings & Backup → **Reset all data** deletes every record, attachment and notification in the open database in one all-or-nothing step and recreates the internal client and its six cost centres. Tick *Add the sample clients and projects again* to get the samples back. Settings such as a custom logo are kept. Export a backup first: a reset cannot be undone otherwise.

## Moving data from the old Access tracker (optional)

Settings & Backup → **Import Access export** → choose `reference/access-data.json` from the migration package. This is separate from restoring a backup and is never done automatically. It keeps every original ID, blank value, four-decimal amount, date and banking string exactly, keeps empty descriptions blank, and does not merge or deduplicate records. Internal projects named exactly like the six cost centres get their stable category. Any anomalies are imported as they are and listed under Reports → Data Quality.

If you prefer to enter everything by hand, skip this step.

## Demo mode

Settings & Backup → *Open demo mode* switches to a completely separate database (`engineeredplans_project_tracker_demo`) where you can load fictional sample records to practise. An orange banner shows while demo mode is active. Your real data is never shown or changed there. *Return to my real data* switches back.

## Accounting rules

- **Money** is stored with Access Currency precision: **four decimal places** (for example `118481.8780`), using exact decimal arithmetic (no floating point). Reports display two decimals with the `PKR` label; negatives are shown in parentheses. Rounding is half away from zero.
- **Dates** are calendar dates (`YYYY-MM-DD`) with no time zone, so they never shift.
- **Income and costs count in full in the month of their Start Date.** The End Date only describes the covered period: nothing is prorated or spread, and no recurring records are created.
- Monthly attribution: time → Work Date; ordinary sales earnings → Activity Date; acquisition commission → the related income Start Date; payouts → Payout Date. All-time reports include future-dated records.
- **Actual result** = paid income − recorded costs − earned sales fees. Margin = actual result ÷ paid income (shown as "—" when there is no income). Totals use total result ÷ total income, not an average of margins.
- **Time value is analytical, not an expense.** Hourly value = rate override if entered (0 is a real zero), otherwise monthly salary ÷ reference hours. Time value = hours worked × hourly value. It never reduces the actual result or company totals. "After Time" (client projects only) = actual result − time value. Changing an employee's salary or reference hours recalculates past entries without an override (the same as Access).
- **Salaries** are recorded automatically from Employees & Rates (see below), so do not also enter them by hand.
- **Company totals** = all income − all recorded costs − all earned sales fees, each counted once. *Total before owner salary* adds back the recorded Owners Salary costs. Internal costs are grouped by a stable category code, so renaming a cost centre never removes its costs from the totals. Other internal projects appear as *Other Internal Costs*.
- **Sales commission:** a Close earns (base override, else credited paid revenue, else 0) × (rate override, else the salesperson's close rate). An attended meeting earns the fee override, else the salesperson's meeting fee. Blank override = use the default; 0 = zero. Defaults are read live.
- **Client acquisition (180 days):** one acquisition record per non-internal client. The salesperson earns the stored acquisition rate on every paid income of that client's *Client*-type projects (including projects added later) whose Start Date is on or after the acquisition date and **before the exclusive stop date = acquisition date + 180 days** (for example 2026-01-01 → stop 2026-06-30). This is 180 days, not six months. Each line is rounded to four decimals. Once a client has an acquisition record, ordinary Close commission (and its credited revenue) for that client is suppressed, whichever salesperson logged it and whatever its date; meeting fees still apply.
- **Salesperson balance:** earned (activities + acquisition) − paid out (legacy per-activity CommissionPaid + Sales Payouts). A negative balance is an advance or overpayment. Paying commission reduces what is owed; it does **not** reduce profit again.

## Recurring income and expenses

Records → **Recurring** holds repeating transactions such as subscriptions, retainers and salaries. Each rule has a type (Income or Cost), a task name, a client/project, an amount, a start date (the first occurrence), an optional end date, and a frequency ("every N days, weeks, months or years").

- Each occurrence becomes a normal income or cost record dated on that occurrence, so it appears in every total and report. The cost item (or income note) is the task name.
- **Occurrences are created at most 2 weeks (14 days) ahead.** Example: Google charges PKR 5,000 on the 11th. That charge appears on the 27th of the month before (shown as "upcoming" in the Recurring column), and never earlier. Entries that were created further ahead under the earlier one-month window, and that you have not edited, are removed automatically and come back when they are within 2 weeks. Hand-edited entries are kept.
- Generation runs when the tracker opens, right after you submit a rule, and every 30 minutes while it is open. A start date in the past adds all past occurrences once (a backfill).
- Monthly rules always count from the start date, so a rule on the 31st gives 28/29 Feb, then 31 Mar, and does not drift.
- Each rule remembers the last occurrence it created. Deleting one generated record does not bring it back, and two open tabs never create duplicates.
- **Whole periods only:** every occurrence is charged in full. The end date is the last day covered (inclusive): occurrences up to and including it are added, each for the full amount, and nothing after it. There are no partial or prorated periods.
- **Ending early:** occurrences are created up to 2 weeks ahead, so a period may already be recorded when a rule ends. Setting or changing the end date also removes entries after the end date that the rule created and you have not edited. Entries you edited by hand are left unchanged, and a message tells you how many.
- Editing a rule (amount, project, frequency) affects only occurrences not yet added. Records already created stay as they are; edit them in Project Income or Project Costs. **Archive** pauses a rule; an end date stops it. Deleting a rule keeps the records it already created.

## Employee salaries

Each employee on Employees & Rates has a **monthly salary**, a **join date** (required) and an optional **leave date**, and is charged to *Team Salaries* (default) or *Owners Salary*.

- The salary is a cost dated the **last day of each month worked**, so it counts in that month's results. It is created through a linked recurring rule (shown on Recurring as "Salary: name"), with the same two-week window.
- Every month worked is paid the **full salary**, including the join month and the leave month (no partial months). Example: a salary of 30,000 and a join date of 23 September gives 30,000 on 30 September and on the last day of each month after. Leaving on 10 November gives 30,000 on 30 November, and nothing after that.
- A join date in the past adds the past months when you submit. The preview shows how many, and warns if a hand-made recurring rule seems to pay the same salary.
- Setting or changing the leave date or join date corrects salary entries you have not edited (months outside the new dates are removed, and earlier months are added). A salary change applies to months not yet added.
- The salary rule is changed only from the employee. Archiving the employee pauses it. A salary of 0 or no join date records nothing.

## Screens and reports

Dashboard · **Clients:** Clients (Contracts, Contract Clauses) · **Records:** Projects · Project Income · Time Entries · Project Costs · Recurring · **Employees:** Employees & Rates · Salespeople · Employee Activities · Sales Payouts · Client Acquisitions · **Confidential:** Employee Bank Details · **Admin:** Reports · Settings & Backup.

Reports: Project Performance — All Months; Monthly Client Performance; Company Totals — Cost Breakdown; Sales Team — Commissions (with opening/closing balances for a date range); Client Acquisition — Commission Detail; Employee Bank Details (confidential); Income by Date; Hours by Date; Costs by Start Date; Sales Activities by Date; Sales Payouts by Date; Monthly Project Summary — Detailed; Data Quality. Each report has filters, sortable columns, CSV export (raw numbers with units in the headers, and protection against spreadsheet formulas) and **Print / Save as PDF** (the browser's print dialog; navigation is hidden and pages are numbered).

## Privacy

Bank details are kept only in this browser's storage on this computer and are never transmitted. They appear only on the Employee Bank Details screen and report, both marked confidential. There is no password: anyone who can use your Windows account and browser can open the tracker, so lock your computer. Store backup files securely, because they contain banking details.

## Tests (for maintainers)

Run from PowerShell in the project folder. Each uses isolated `engineeredplans_test_*` databases in a temporary browser profile, never your live data:

```powershell
powershell -ExecutionPolicy Bypass -File tests\run-tests.ps1      # calculations, storage, backup/restore, import (23 checks)
powershell -ExecutionPolicy Bypass -File tests\ui-smoke.ps1       # real UI workflows, navigation, print PDFs, mobile layout
powershell -ExecutionPolicy Bypass -File tests\persistence.ps1    # reload, browser close, server restart
```

You can also open http://localhost:4173/tests/ in the browser while the server runs. To check the Access import against the supplied reconciliation totals, temporarily copy `access-data.json` and `source-reconciliation.json` into `tests\private\`, run `run-tests.ps1`, then delete that folder. Without them that check shows `SKIP`.

A manual check that automation cannot do: enter a record, restart Windows, start the tracker and confirm the record is still there.

## Project layout

```
index.html, css/app.css            UI shell and styles (including print CSS)
js/lib/        decimal.js (exact BigInt decimals), dates.js, format.js
js/model/      schema.js (stores, Access table/field mapping), validate.js
js/storage/    db.js (IndexedDB, migrations, transactions, revisions, cross-tab channel)
js/calc/       calc.js (all business calculations), quality.js (Data Quality)
js/reports/    reports.js (report and query-view definitions)
js/io/         backup.js, accessImport.js, csv.js, download.js, fixtures.js (test/demo only)
js/ui/         app shell, router, generic list/editor, screens/*
launcher/      serve.ps1 (loopback server on port 4173), stop.ps1
tests/         browser test suite and PowerShell drivers
docs/SCHEMA.md database schema, migrations and Access mapping
```
