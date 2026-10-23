// Attachments: receipts on costs and invoices on income, stored with the record, in backups, and safe from recurring clean-ups.
import { test, assert, eq, rejects } from './harness.js';
import { freshDB } from './db.test.js';
import { buildBackup, backupJSON, parseBackup, restoreParsed } from '../js/io/backup.js';

const file = (name, text, type = 'application/pdf') => { const blob = new Blob([text], { type }); return { name, type, size: blob.size, blob }; };

test('attachments (db): add to a cost, contents kept, deleted with the record', async () => {
  const db = await freshDB();
  const c = await db.create('costs', { ProjectID: 1, StartDate: '2026-10-01', EndDate: null, CostItem: 'Laptop', CostAmount: '1000.0000', CostNotes: null });
  const [a, b] = await db.addAttachments('costs', c.CostID, [file('receipt.pdf', '%PDF-1 receipt'), file('photo.png', 'png-bytes', 'image/png')]);
  eq(a.Store, 'costs'); eq(a.RecordID, c.CostID); eq(b.AttachmentID, a.AttachmentID + 1);
  eq(await (await db.getFile(a.AttachmentID)).text(), '%PDF-1 receipt');
  let ds = await db.loadAll(); eq(ds.attachments.length, 2);
  await db.removeAttachments([b.AttachmentID]);
  ds = await db.loadAll(); eq(ds.attachments.length, 1); eq(await db.getFile(b.AttachmentID), null);
  await rejects(db.addAttachments('costs', 9999, [file('x.pdf', 'x')]), /no longer exists/);
  await rejects(db.addAttachments('recurring', 1, [file('x.pdf', 'x')]), /correct the highlighted/i);
  await db.remove('costs', c.CostID, ds.costs.find((x) => x.CostID === c.CostID).revision);
  ds = await db.loadAll(); eq(ds.attachments.length, 0, 'deleted with its cost'); eq(await db.getFile(a.AttachmentID), null);
});

test('attachments (db): backup carries the file contents; restore brings them back exactly', async () => {
  const db = await freshDB();
  const i = await db.create('income', { ProjectID: 1, StartDate: '2026-10-01', EndDate: null, AmountPaid: '5000.0000', IncomeNotes: null });
  const [a] = await db.addAttachments('income', i.IncomeID, [file('invoice-001.pdf', 'INVOICE 001 ✓')]);
  const b = await buildBackup(db);
  eq(b.files.length, 1); assert(b.files[0].dataUrl.startsWith('data:application/pdf;base64,'));
  const parsed = parseBackup(backupJSON(b));
  assert(parsed.ok, parsed.errors.join('\n'));
  const db2 = await freshDB();
  await restoreParsed(db2, parsed);
  const ds = await db2.loadAll();
  eq(ds.attachments.length, 1); eq(ds.attachments[0].FileName, 'invoice-001.pdf');
  eq(await (await db2.getFile(a.AttachmentID)).text(), 'INVOICE 001 ✓');
  // a backup whose file contents are missing is refused
  const broken = JSON.parse(backupJSON(b)); broken.files = [];
  assert(!parseBackup(JSON.stringify(broken)).ok, 'missing contents rejected');
});

test('attachments (db): recurring clean-ups and rebuilds never delete an entry that has a receipt', async () => {
  const db = await freshDB();
  await db.create('recurring', { Kind: 'Cost', ProjectID: 4, Name: 'Hosting', Amount: '3000.0000', StartDate: '2026-09-01', IntervalCount: 1, IntervalUnit: 'month' });
  await db.generateRecurring('2026-10-20'); // Sep 1, Oct 1, Nov 1
  let ds = await db.loadAll(); eq(ds.costs.length, 3);
  const nov = ds.costs.find((c) => c.StartDate === '2026-11-01');
  await db.addAttachments('costs', nov.CostID, [file('nov.pdf', 'nov')]);
  // ending the rule in October would remove the untouched November entry, but it has a receipt
  let rule = (await db.loadAll()).recurring[0];
  const u = await db.update('recurring', { ...rule, EndDate: '2026-10-15' }, rule.revision);
  eq(u._adjusted.deleted, 0); eq(u._adjusted.skipped, 1);
  ds = await db.loadAll(); assert(ds.costs.some((c) => c.CostID === nov.CostID), 'kept');
  // "Save & update old entries" keeps it too, and does not add a second November entry
  rule = ds.recurring[0];
  await db.update('recurring', { ...rule, EndDate: null, Amount: '3500.0000' }, rule.revision, { entries: 'rebuild' });
  ds = await db.loadAll();
  eq(ds.costs.filter((c) => c.StartDate === '2026-11-01').length, 1, 'one November entry');
  eq(ds.costs.find((c) => c.CostID === nov.CostID).CostAmount, '3000.0000', 'attached entry left as it was');
  eq(ds.attachments.length, 1);
});

test('data quality: % of income (to date) without an invoice; owners are not flagged for missing dates', async () => {
  const { invoiceCoverage, dataQualityIssues } = await import('../js/calc/quality.js');
  const { emptyDs } = await import('../js/io/fixtures.js');
  const ds = emptyDs();
  ds.income = [1, 2, 3, 4].map((id) => ({ IncomeID: id, ProjectID: 1, StartDate: id === 4 ? '2099-01-01' : '2026-01-0' + id, EndDate: null, AmountPaid: '1.0000' }));
  ds.attachments = [{ AttachmentID: 1, Store: 'income', RecordID: 2 }, { AttachmentID: 2, Store: 'income', RecordID: 2 }, { AttachmentID: 3, Store: 'costs', RecordID: 1 }];
  const c = invoiceCoverage(ds, '2026-10-23');
  eq(c.total, 3); eq(c.withInvoice, 1); eq(c.without, 2); eq(c.pct.toFixed(1), '66.7'); eq(c.future, 1);
  eq(invoiceCoverage({ income: [], attachments: [] }).pct, null);
  const person = (id, extra) => ({ PersonID: id, PersonName: 'P' + id, MonthlyReferenceValue: '1.0000', ReferenceHours: 1, JoinDate: null, LeaveDate: null, Archived: null, ...extra });
  const q = emptyDs();
  q.people = [person(1, { IsOwner: true }), person(2, { SalaryCategory: 'OWNERS_SALARY' }), person(3, {})];
  eq(dataQualityIssues(q).filter((i) => i.field === 'JoinDate').map((i) => i.id).join(), '3', 'only the non-owner is flagged');
});
