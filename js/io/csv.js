// CSV with raw numeric values, labelled units, and spreadsheet-formula protection for user text.
import { Dec } from '../lib/decimal.js';
import { BASE_SYMBOL } from '../calc/fx.js';

const FORMULA_RE = /^[=+\-@\t\r]/;

export function csvCell(v, type = 'text') {
  if (v === null || v === undefined) return '';
  let s;
  if (v instanceof Dec) s = type === 'money' ? v.toFixed(4) : v.toString();
  else s = String(v);
  if ((type === 'text' || type === 'date') && FORMULA_RE.test(s)) s = "'" + s; // neutralise =cmd(), +1, -1, @x
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

const UNIT = { money: ` (${BASE_SYMBOL})`, hours: ' (hours)', pct: ' (%)', rate: ' (%)' };

// Percent-type columns are exported as percentage numbers (85.0000), labelled "(%)".
function rawValue(col, row) {
  const v = col.value ? col.value(row) : row[col.key];
  if (v === null || v === undefined) return v;
  if (col.type === 'pct' || col.type === 'rate') return Dec.from(v).mul(100).round(6).toString();
  if (col.type === 'money') return Dec.from(v).toFixed(4);
  if (col.type === 'hours') return Dec.from(v).toString();
  return v;
}

export function toCSV(columns, rows, { totals = null } = {}) {
  const cols = columns.filter((c) => !c.noExport);
  const lines = [cols.map((c) => csvCell(c.label + (UNIT[c.type] || ''))).join(',')];
  for (const r of rows) lines.push(cols.map((c) => csvCell(rawValue(c, r), c.type)).join(','));
  // The totals row is rendered like any row; reports put the "Total" label into its first text column.
  if (totals) lines.push(cols.map((c) => csvCell(rawValue(c, totals), c.type)).join(','));
  return '﻿' + lines.join('\r\n') + '\r\n';
}
