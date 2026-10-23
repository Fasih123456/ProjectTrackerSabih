// Multi-currency: conversion, recurring entries in another currency, and the batch rate update.
import { test, assert, eq } from './harness.js';
import { freshDB } from './db.test.js';
import { baseAmount, rateFrom, setLatestDay, latestRate, applyRate, nativeAmount, isForeign, clearFx } from '../js/calc/fx.js';
import { recordsForOccurrence, planRuleAdjustments, foreignRuleBlocked } from '../js/calc/recurring.js';
import { validateRecord, ctxFromDataset } from '../js/model/validate.js';
import { parseBackup } from '../js/io/backup.js';

const DAY_1 = { date: '2026-10-01', rates: { usd: 1, cad: 277.00876191, aed: 3.6725, pkr: 1.42483855 } };
const DAY_23 = { date: '2026-10-23', rates: { usd: 1, cad: 276.98617, aed: 3.6725, pkr: 1.401351 } };

test('fx: CAD per unit from a day of USD-based rates; exact 4-decimal CAD amounts', () => {
  eq(rateFrom(DAY_1, 'USD'), 277.00876191);
  eq(rateFrom(DAY_1, 'aed').toFixed(6), (277.00876191 / 3.6725).toFixed(6));
  eq(rateFrom(DAY_1, 'XYZ'), null);
  eq(baseAmount('100.0000', 277.00876191), '27700.8762');
  eq(baseAmount('0.0000', 300), '0.0000');
  const r = applyRate('income', { Currency: 'USD', OriginalAmount: '250.0000' }, 280, '2026-10-01', 'final');
  eq(r.AmountPaid, '70000.0000'); eq(r.FxStatus, 'final');
  eq(nativeAmount('income', r), 'USD 250.0000');
  eq(nativeAmount('income', clearFx({ ...r, AmountPaid: '5.0000' })), '5.0000');
  assert(!isForeign({ Currency: 'CAD' }) && !isForeign({ Currency: null }) && isForeign({ Currency: 'PKR' }));
});

test('fx: validation requires an amount and a positive rate for other currencies only', () => {
  const ctx = ctxFromDataset({ projects: [{ ProjectID: 7 }], clients: [], income: [], costs: [] });
  const base = { ProjectID: 7, StartDate: '2026-10-01', EndDate: null, AmountPaid: '1.0000', IncomeNotes: null };
  eq(Object.keys(validateRecord('income', { ...base, Currency: null }, ctx)).length, 0);
  const e = validateRecord('income', { ...base, Currency: 'USD', OriginalAmount: null, FxRate: null }, ctx);
  assert(e.OriginalAmount && e.FxRate, JSON.stringify(e));
  assert(validateRecord('income', { ...base, Currency: 'usd', OriginalAmount: '1.0000', FxRate: 2 }, ctx).Currency);
});

test('fx: recurring rule in USD makes USD entries at the latest rate (provisional); untouched check ignores the rate', () => {
  setLatestDay(DAY_23);
  const rule = { RecurringID: 9, Kind: 'Income', Name: 'Retainer', ProjectID: 7, Amount: '1000.0000', Currency: 'USD', StartDate: '2026-10-01', EndDate: null, IntervalCount: 1, IntervalUnit: 'month', Notes: null };
  assert(!foreignRuleBlocked(rule));
  const [{ store, record }] = recordsForOccurrence(rule, '2026-11-01');
  eq(store, 'income'); eq(record.Currency, 'USD'); eq(record.OriginalAmount, '1000.0000');
  eq(record.FxStatus, 'provisional'); eq(record.FxDate, '2026-10-23');
  eq(record.AmountPaid, baseAmount('1000.0000', latestRate('USD').rate));
  // The background job later sets the rate of 1 Nov: the entry still counts as untouched, so ending the rule
  // before 1 Nov removes it (a hand-edited entry would be kept).
  const saved = applyRate('income', { IncomeID: 1, revision: 2, ...record }, 280, '2026-11-01', 'final');
  const p = planRuleAdjustments(rule, { ...rule, EndDate: '2026-10-15' }, [saved]);
  eq(p.deletes.length, 1); eq(p.skipped.length, 0);
  eq(planRuleAdjustments(rule, { ...rule, EndDate: '2026-11-15' }, [saved]).updates.length, 0, 'still due: unchanged');
  // No rate for a currency yet: the rule waits.
  assert(foreignRuleBlocked({ ...rule, Currency: 'ZZZ' }));
});

test('fx (db): v6 rate cache, batch rate update skips manual rates and bumps revisions', async () => {
  const db = await freshDB();
  await db.putFxDay(DAY_1); await db.putFxDay(DAY_23);
  eq((await db.latestFxDay()).date, '2026-10-23');
  eq((await db.getFxDay('2026-10-01')).rates.cad, 277.00876191);
  const a = await db.create('income', { ProjectID: 1, StartDate: '2026-10-30', EndDate: null, AmountPaid: '27698.6170', IncomeNotes: null, Currency: 'USD', OriginalAmount: '100.0000', FxRate: 276.98617, FxDate: '2026-10-23', FxStatus: 'provisional' });
  const b = await db.create('costs', { ProjectID: 1, StartDate: '2026-10-30', EndDate: null, CostItem: 'x', CostAmount: '28000.0000', CostNotes: null, Currency: 'USD', OriginalAmount: '100.0000', FxRate: 280, FxDate: '2026-10-30', FxStatus: 'manual' });
  const n = await db.applyFxRates([
    { store: 'income', id: a.IncomeID, rate: 281.5, date: '2026-10-30', status: 'final' },
    { store: 'costs', id: b.CostID, rate: 281.5, date: '2026-10-30', status: 'final' },
  ]);
  eq(n, 1);
  const ds = await db.loadAll();
  const inc = ds.income.find((x) => x.IncomeID === a.IncomeID), cost = ds.costs.find((x) => x.CostID === b.CostID);
  eq(inc.AmountPaid, '28150.0000'); eq(inc.FxStatus, 'final'); eq(inc.revision, a.revision + 1);
  eq(cost.FxRate, 280); eq(cost.FxStatus, 'manual'); eq(cost.revision, b.revision);
});

test('fx: backups before v6 restore unchanged; settings.currencies must be codes', () => {
  const base = { format: 'engineeredplans-project-tracker-backup', backupVersion: 5, schemaVersion: 5, stores: Object.fromEntries(['clients', 'projects', 'people', 'salespeople', 'income', 'timeEntries', 'costs', 'activities', 'payouts', 'acquisitions', 'recurring', 'contracts', 'clauses', 'sources'].map((s) => [s, []])) };
  assert(parseBackup(JSON.stringify(base)).ok, 'v5 backup accepted');
  assert(parseBackup(JSON.stringify({ ...base, backupVersion: 6, settings: { currencies: ['USD', 'AED'] } })).ok);
  assert(!parseBackup(JSON.stringify({ ...base, backupVersion: 6, settings: { currencies: ['usd'] } })).ok);
});
