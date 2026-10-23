// Multi-currency helpers. Every income and cost keeps its amount in the base currency (BASE, CAD) in AmountPaid / CostAmount, so all totals,
// reports and the ledger stay in CAD. A foreign-currency record also stores:
//   Currency        3-letter code (blank = CAD)
//   OriginalAmount  the amount in that currency (4-decimal money string)
//   FxRate          CAD per 1 unit of the currency that was used (mid-market, or the actual rate received)
//   FxDate          the day that rate belongs to
//   FxStatus        'final' (the rate of the record's own date), 'provisional' (a stand-in: the record is dated in
//                   the future, or its day's rate is not published yet; replaced automatically) or 'manual'
//                   (the actual rate received, typed in; never changed automatically).
// Recurring rules store Currency only; Amount is then in that currency.
import { Dec } from '../lib/decimal.js';

export const BASE = 'CAD';
export const BASE_NAME = 'Canadian dollar';
export const BASE_SYMBOL = '$'; // shown on amounts: "$1,234.56"
export const BASE_LABEL = 'CAD$'; // names the primary currency in text
export const AMOUNT_FIELD = { income: 'AmountPaid', costs: 'CostAmount' };
export const FX_STATUSES = ['final', 'provisional', 'manual'];
export const CURRENCY_RE = /^[A-Z]{3}$/;
export const DEFAULT_CURRENCIES = ['USD', 'PKR', 'AED'];

export const isForeign = (r) => !!r && typeof r.Currency === 'string' && r.Currency !== '' && r.Currency !== BASE;

// CAD amount (4-decimal money string) for an amount in another currency at `rate` CAD per unit.
export const baseAmount = (original, rate) => Dec.from(original).mul(Dec.from(String(rate))).round(4).toMoney();

// One day of published rates: { date, rates: { usd: 1, cad: 1.40, aed: 3.67, … } } (units per 1 USD, lower-case codes).
// Returns CAD per 1 unit of `code`, or null when the day does not list it.
export function rateFrom(day, code) {
  if (!day || !day.rates) return null;
  const base = day.rates[BASE.toLowerCase()], x = day.rates[String(code).toLowerCase()];
  if (!(base > 0) || !(x > 0)) return null;
  return +(base / x).toPrecision(12);
}

// The most recent day of rates known to this tab (loaded from the local cache at start-up, refreshed hourly).
let latestDay = null;
export function setLatestDay(day) { if (day && (!latestDay || day.date >= latestDay.date)) latestDay = day; }
export const getLatestDay = () => latestDay;
export function latestRate(code) {
  const rate = rateFrom(latestDay, code);
  return rate === null ? null : { rate, date: latestDay.date };
}

// Sets the FX fields and the CAD amount of an income / cost record (mutates and returns it).
export function applyRate(store, rec, rate, date, status) {
  rec.FxRate = rate; rec.FxDate = date; rec.FxStatus = status;
  rec[AMOUNT_FIELD[store]] = baseAmount(rec.OriginalAmount, rate);
  return rec;
}
// Clears the FX fields of a CAD record.
export function clearFx(rec) {
  rec.Currency = null; rec.OriginalAmount = null; rec.FxRate = null; rec.FxDate = null; rec.FxStatus = null;
  return rec;
}

// The amount as entered, for comparing records independent of the exchange rate ("USD 100.0000" or the CAD amount).
export const nativeAmount = (store, r) => (isForeign(r) ? `${r.Currency} ${r.OriginalAmount}` : r[AMOUNT_FIELD[store]] ?? null);

// "USD 1,250.00"
export function fmtForeign(code, amount) {
  const [i, f = ''] = Dec.from(amount).round(2).toFixed(2).split('.');
  const neg = i.startsWith('-');
  return `${code} ${neg ? '-' : ''}${(neg ? i.slice(1) : i).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}
// "277.0088" (rates shown with 4 decimals)
export const fmtRateValue = (rate) => (rate === null || rate === undefined ? '—' : Number(rate).toFixed(4));
