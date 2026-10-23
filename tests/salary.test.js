import { test, assert, eq, rejects } from './harness.js';
import { freshDB } from './db.test.js';
import { occurrencesBetween, occurrenceAmount, recordsForOccurrence, planRuleAdjustments, frequencyLabel, salaryRuleFor, endBound } from '../js/calc/recurring.js';

// ---------- employee salaries ----------
test('salary: paid in full at each month end from the join month to the leave month', () => {
  const aisha = { PersonID: 3, PersonName: 'Aisha', MonthlyReferenceValue: '30000.0000', JoinDate: '2026-09-23', LeaveDate: null, SalaryCategory: null, Archived: null };
  const projects = [{ ProjectID: 5, ProjectType: 'Internal', CategoryCode: 'TEAM_SALARIES' }, { ProjectID: 6, ProjectType: 'Internal', CategoryCode: 'OWNERS_SALARY' }];
  const rule = { RecurringID: 1, ...salaryRuleFor(aisha, null, projects) };
  eq(rule.ProjectID, 5); eq(rule.Name, 'Salary: Aisha'); eq(rule.StartDate, '2026-09-23');
  eq(salaryRuleFor({ ...aisha, SalaryCategory: 'OWNERS_SALARY' }, null, projects).ProjectID, 6, 'owners salary cost centre');
  eq(occurrencesBetween(rule, null, '2027-01-01').join(), '2026-09-30,2026-10-31,2026-11-30,2026-12-31', 'last day of each month');
  eq(occurrenceAmount(rule, '2026-09-30').amount, '30000.0000', 'join month paid in full');
  eq(recordsForOccurrence(rule, '2026-09-30')[0].record.CostNotes, null, 'no partial note');
  // leaving mid-month: that month is paid in full at its month end; nothing after
  const left = { ...rule, EndDate: '2026-11-10' };
  eq(occurrencesBetween(left, null, '2027-06-01').join(), '2026-09-30,2026-10-31,2026-11-30');
  eq(endBound(left), '2026-12-01');
  eq(occurrenceAmount(left, '2026-11-30').amount, '30000.0000', 'leave month paid in full');
  eq(frequencyLabel(rule), 'Monthly salary (month end)');
  // no salary or no join date: no rule; an existing rule is paused
  eq(salaryRuleFor({ ...aisha, JoinDate: null }, null, projects), null);
  eq(salaryRuleFor({ ...aisha, MonthlyReferenceValue: '0.0000' }, rule, projects).Archived, true);
});

test('salary: setting a leave date or moving the join date removes or keeps whole months', () => {
  const rule = { RecurringID: 1, Kind: 'Cost', ProjectID: 5, Name: 'Salary: Aisha', Notes: null, Amount: '30000.0000', StartDate: '2026-09-23', EndDate: null, IntervalCount: 1, IntervalUnit: 'month', Schedule: 'salary', PersonID: 3 };
  const recs = ['2026-09-30', '2026-10-31', '2026-11-30'].map((d, i) => ({ CostID: i + 1, revision: 1, ...recordsForOccurrence(rule, d)[0].record }));
  const p = planRuleAdjustments(rule, { ...rule, EndDate: '2026-10-15' }, recs);
  eq(p.updates.length, 0, 'October stays in full');
  eq(p.deletes.map((d) => d.StartDate).join(), '2026-11-30', 'month after leaving removed');
  const later = planRuleAdjustments(rule, { ...rule, StartDate: '2026-10-05' }, recs);
  eq(later.deletes.map((d) => d.StartDate).join(), '2026-09-30', 'month before the corrected join date removed');
  eq(later.updates.length, 0, 'first month stays in full');
  const edited = recs.map((r) => (r.StartDate === '2026-11-30' ? { ...r, CostAmount: '1.0000' } : r));
  eq(planRuleAdjustments(rule, { ...rule, EndDate: '2026-10-15' }, edited).skipped.length, 1, 'hand-edited entry left alone');
});

test('salary (db): employee join/leave dates keep a salary rule in step; every month paid in full', async () => {
  const db = await freshDB();
  await rejects(db.create('people', { PersonName: 'X', MonthlyReferenceValue: '1.0000', ReferenceHours: 1 }), /join date/, 'join date required');
  await rejects(db.create('people', { PersonName: 'X', MonthlyReferenceValue: '1.0000', ReferenceHours: 1, JoinDate: '2026-02-01', LeaveDate: '2026-01-01' }), /on or after the join date/);
  const p = await db.create('people', { PersonName: 'Aisha', MonthlyReferenceValue: '30000.0000', ReferenceHours: 80, JoinDate: '2026-09-23' });
  let ds = await db.loadAll();
  const rule = ds.recurring.find((r) => r.PersonID === p.PersonID);
  assert(rule && rule.Schedule === 'salary' && rule.ProjectID === 5 && rule.Amount === '30000.0000', 'salary rule created under Team Salaries');
  await db.generateRecurring('2026-10-20');
  ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.StartDate}:${c.CostAmount}`).join(), '2026-09-30:30000.0000,2026-10-31:30000.0000');
  // the rule is managed from the employee only
  await rejects(db.update('recurring', { ...ds.recurring[0], Amount: '1.0000' }, ds.recurring[0].revision), /managed on Employees/);
  await rejects(db.remove('recurring', rule.RecurringID, ds.recurring[0].revision), /managed on Employees/);
  await rejects(db.remove('people', p.PersonID, p.revision), /depend on it/, 'cannot delete an employee whose salary was recorded');
  // leaving on 15 Oct: October stays in full
  let cur = ds.people[0];
  await db.update('people', { ...cur, LeaveDate: '2026-10-15' }, cur.revision);
  ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.StartDate}:${c.CostAmount}`).join(), '2026-09-30:30000.0000,2026-10-31:30000.0000');
  // join date corrected to 1 Aug: August added
  cur = ds.people[0];
  const u = await db.update('people', { ...cur, JoinDate: '2026-08-01' }, cur.revision);
  eq(u._adjusted.created, 1); eq(u._adjusted.updated, 0);
  ds = await db.loadAll();
  eq(ds.costs.map((c) => `${c.StartDate}:${c.CostAmount}`).sort().join(), '2026-08-31:30000.0000,2026-09-30:30000.0000,2026-10-31:30000.0000');
  await db.generateRecurring('2026-12-20'); ds = await db.loadAll(); eq(ds.costs.length, 3, 'nothing after the leave month');
  // archiving pauses the salary; owners salary goes to Owners Salary
  cur = ds.people[0];
  await db.update('people', { ...cur, Archived: true }, cur.revision);
  ds = await db.loadAll(); eq(ds.recurring[0].Archived, true);
  const o = await db.create('people', { PersonName: 'Fasih', MonthlyReferenceValue: '320000.0000', ReferenceHours: 160, JoinDate: '2099-01-01', SalaryCategory: 'OWNERS_SALARY' });
  ds = await db.loadAll(); eq(ds.recurring.find((r) => r.PersonID === o.PersonID).ProjectID, 6);
  await db.remove('people', o.PersonID, o.revision);
  ds = await db.loadAll(); assert(!ds.recurring.some((r) => r.PersonID === o.PersonID), 'unused salary rule removed with the employee');
});

test('salary (db): the owner needs no join date and gets no automatic salary entries; an existing schedule is paused', async () => {
  const db = await freshDB();
  const owner = await db.create('people', { PersonName: 'Fasih', MonthlyReferenceValue: '320000.0000', ReferenceHours: 160, IsOwner: true, JoinDate: null, LeaveDate: null });
  eq(owner.IsOwner, true);
  await rejects(db.create('people', { PersonName: 'Staff', MonthlyReferenceValue: '1000.0000', ReferenceHours: 160, JoinDate: null }), /join date/i, 'others still need a join date');
  const emp = await db.create('people', { PersonName: 'Was staff', MonthlyReferenceValue: '1000.0000', ReferenceHours: 160, JoinDate: '2026-01-01' });
  let ds = await db.loadAll();
  eq(ds.recurring.filter((r) => r.PersonID === owner.PersonID).length, 0, 'no salary rule for the owner');
  assert(ds.recurring.some((r) => r.PersonID === emp.PersonID && !r.Archived), 'employee has an active salary rule');
  await db.update('people', { ...emp, IsOwner: true, JoinDate: null }, emp.revision);
  ds = await db.loadAll();
  assert(ds.recurring.find((r) => r.PersonID === emp.PersonID).Archived, 'marking as owner pauses the salary rule');
  await db.generateRecurring('2026-10-18'); ds = await db.loadAll();
  eq(ds.costs.filter((c) => c.CostItem === 'Salary: Fasih').length, 0);
});
