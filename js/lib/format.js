import { Dec } from './decimal.js';
import { BASE, BASE_SYMBOL } from '../calc/fx.js';

function groupDigits(s) {
  const [int, frac] = s.split('.');
  const g = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return frac !== undefined ? `${g}.${frac}` : g;
}

// "$1,234.56"; negatives as "($1,234.56)" to match the Access reports.
export function fmtMoney(v, { label = true, parens = true } = {}) {
  if (v === null || v === undefined) return '—';
  const d = Dec.from(v);
  const neg = d.round(2).sign() < 0;
  const body = groupDigits(d.abs().toFixed(2));
  const txt = label ? `${BASE_SYMBOL}${body}` : body;
  if (!neg) return txt;
  return parens ? `(${txt})` : `-${txt}`;
}

// Four-decimal detail, e.g. for editors that show the stored Currency value.
export function fmtMoney4(v) { return v === null || v === undefined ? '' : groupDigits(Dec.from(v).toFixed(4)); }

// Hours are quantities, never money. Show up to 2 decimals, keep exact stored value available elsewhere.
export function fmtHours(v) {
  if (v === null || v === undefined) return '—';
  const d = Dec.from(v);
  const s = d.s > 2 ? d.toString() : d.toFixed(2);
  return groupDigits(s);
}

// Fraction (0.05) -> "5%"; up to 4 decimals of percent precision without floating noise.
export function fmtRate(v) {
  if (v === null || v === undefined) return '—';
  return Dec.from(v).mul(100).round(4).toString() + '%';
}

// Margin fraction -> "85.0%" (one decimal). null -> "—".
export function fmtMargin(v) {
  if (v === null || v === undefined) return '—';
  const d = Dec.from(v).mul(100).round(1);
  return d.sign() < 0 ? `(${d.abs().toFixed(1)}%)` : `${d.toFixed(1)}%`;
}

export function fmtInt(v) { return v === null || v === undefined ? '—' : groupDigits(String(v)); }

export function fmtDate(v) { return v || '—'; }

export function fmtDateTime(iso) {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  return d.toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function fmtBytes(n) {
  if (n === undefined || n === null) return 'unknown';
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 1 : 0)} ${u[i]}`;
}

// Accepts a leading "$", "CAD" or "CAD$" (after an optional minus sign).
const BASE_PREFIX = new RegExp(`^(-?)\\s*(?:${BASE})?\\s*\\$?\\s*`, 'i');
// Parse a user-entered amount like "1,234.5" -> "1234.5000"; returns {value} or {error}.
export function parseMoneyInput(text, { allowNegative = false } = {}) {
  const t = String(text ?? '').trim().replace(/,/g, '').replace(BASE_PREFIX, '$1');
  if (t === '') return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: 'Enter a number, e.g. 1500 or 1,500.50' };
  const frac = (t.split('.')[1] || '');
  if (frac.length > 4) return { error: 'Use at most 4 decimal places' };
  const d = Dec.from(t);
  if (!allowNegative && d.sign() < 0) return { error: 'Must not be negative' };
  return { value: d.toMoney() };
}

// Decimal hours, e.g. "3.3" -> 3.3 (a JS number, like the Access Double field).
export function parseNumberInput(text, { allowNegative = false } = {}) {
  const t = String(text ?? '').trim().replace(/,/g, '');
  if (t === '') return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: 'Enter a decimal number, e.g. 3.25' };
  const n = Number(t);
  if (!Number.isFinite(n)) return { error: 'Number is not finite' };
  if (!allowNegative && n < 0) return { error: 'Must not be negative' };
  return { value: n };
}

// Percent entry "5" -> 0.05 stored as a fraction (never multiplied twice).
export function parsePercentInput(text) {
  const t = String(text ?? '').trim().replace(/%$/, '').trim();
  if (t === '') return { value: null };
  if (!/^-?\d+(\.\d+)?$/.test(t)) return { error: 'Enter a percentage, e.g. 5 or 2.5' };
  const frac = Dec.from(t).div(100, 10);
  if (frac.sign() < 0 || frac.gt(1)) return { error: 'Must be between 0% and 100%' };
  return { value: frac.toNumber() };
}

export const rateToPercentText = (v) => v === null || v === undefined ? '' : Dec.from(v).mul(100).round(6).toString();
export const moneyToInputText = (v) => v === null || v === undefined ? '' : Dec.from(v).toString();
export const numberToInputText = (v) => v === null || v === undefined ? '' : Dec.from(v).toString();

// "1:30" -> 1.5 ; returns null if not HH:MM.
export function hhmmToDecimal(text) {
  const m = /^\s*(\d+):([0-5]\d)\s*$/.exec(String(text || ''));
  if (!m) return null;
  return Dec.from(m[1]).add(Dec.from(m[2]).div(60, 6)).round(4).toNumber();
}
