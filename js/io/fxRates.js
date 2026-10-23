// Exchange rates: daily mid-market rates from the free fawazahmed0 currency API (no key; published once a day,
// history from March 2024), cached per day in the local fxRates store, so each day is downloaded once.
// Background job (syncFx): refreshes the latest rates, then gives every income/cost whose rate is provisional the
// rate of its own date once that day's rates are published. It runs when the app opens and every hour while open.
import { app } from '../ui/state.js';
import { todayISO, addDays } from '../lib/dates.js';
import { BASE, isForeign, rateFrom, setLatestDay, latestRate, getLatestDay, CURRENCY_RE, DEFAULT_CURRENCIES } from '../calc/fx.js';

const SOURCES = [
  (tag) => `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${tag}/v1/currencies/usd.min.json`,
  (tag) => `https://${tag}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];
const NAMES_URL = 'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.min.json';
export const SOURCE_LABEL = 'fawazahmed0 currency API (daily mid-market rates)';

class NotPublished extends Error { constructor(date) { super(`No exchange rates are published for ${date}.`); this.name = 'NotPublished'; } }
export const isNotPublished = (e) => e?.name === 'NotPublished';

const memory = new Map(); // date -> day (this tab)
const missing = new Map(); // date -> time it was found unpublished (not re-asked for 30 minutes)

async function download(tag) {
  let lastErr = null, notFound = 0;
  for (const url of SOURCES) {
    try {
      const res = await fetch(url(tag), { cache: 'no-store' });
      if (res.status === 404) { notFound++; continue; }
      if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
      const j = await res.json();
      if (!j || typeof j.date !== 'string' || !j.usd || !(j.usd[BASE.toLowerCase()] > 0)) { lastErr = new Error('unexpected response'); continue; }
      return { date: j.date, rates: j.usd, fetchedAt: new Date().toISOString(), source: 'fawazahmed0' };
    } catch (e) { lastErr = e; }
  }
  // A dated mirror subdomain does not exist until that day is published, so it fails as a network error rather
  // than a 404: one "not found" is enough to know the day is not published yet.
  if (notFound === SOURCES.length || (notFound > 0 && tag !== 'latest')) throw new NotPublished(tag);
  throw new Error(`Could not download exchange rates (${lastErr?.message || 'network error'}). Check the internet connection.`);
}

// The rates of one day (cached). Throws NotPublished when that day has no rates (future, today before publishing,
// or before the source's history starts).
export async function getDay(date) {
  if (memory.has(date)) return memory.get(date);
  const cached = await app.db.getFxDay(date);
  if (cached) { memory.set(date, cached); return cached; }
  const seen = missing.get(date);
  if (seen && Date.now() - seen < 30 * 60 * 1000) throw new NotPublished(date);
  try {
    const day = await download(date);
    if (day.date !== date) throw new NotPublished(date);
    await app.db.putFxDay(day);
    memory.set(date, day);
    setLatestDay(day);
    return day;
  } catch (e) { if (isNotPublished(e)) missing.set(date, Date.now()); throw e; }
}

// Downloads the newest published day (cached under its own date) and makes it the "latest" rate.
export async function refreshLatest() {
  const day = await download('latest');
  if (!memory.has(day.date)) { await app.db.putFxDay(day); memory.set(day.date, day); }
  setLatestDay(day);
  return day;
}

// Loads the newest cached day at start-up, so conversions work offline straight away.
export async function loadCachedLatest() {
  const day = await app.db.latestFxDay();
  if (day) { memory.set(day.date, day); setLatestDay(day); }
  return day;
}

// The rate to use for an amount in `code` dated `date`:
//  - dated today or earlier and that day is published -> that day's rate, 'final'
//  - otherwise (future date, not published yet, or older than the source's history) -> the latest rate, 'provisional'
// Returns { rate, date, status, note }.
export async function rateFor(code, date) {
  const today = todayISO();
  if (date <= today) {
    try {
      const day = await getDay(date);
      const rate = rateFrom(day, code);
      if (rate !== null) return { rate, date, status: 'final', note: null };
    } catch (e) { if (!isNotPublished(e)) throw e; }
  }
  if (!latestRate(code)) { try { await refreshLatest(); } catch (e) { if (!getLatestDay()) throw e; } }
  const lr = latestRate(code);
  if (!lr) throw new Error(`No exchange rate is available for ${code}.`);
  const note = date > today ? `Dated in the future: the rate of ${lr.date} is used until ${date}'s rate is published, then it is updated automatically.`
    : date >= addDays(today, -3) ? `${date}'s rate is not published yet: the rate of ${lr.date} is used for now and updated automatically.`
      : `No published rate for ${date} (the free source starts in March 2024): the rate of ${lr.date} is used. Enter the actual rate if you know it.`;
  return { ...lr, status: 'provisional', note };
}

// Enabled currencies (codes other than the base), from Settings; USD, PKR and AED to begin with.
export function enabledCurrencies() {
  const list = app.settings?.currencies;
  return Array.isArray(list) ? list.filter((c) => CURRENCY_RE.test(c) && c !== BASE) : [...DEFAULT_CURRENCIES];
}
export async function setEnabledCurrencies(codes) {
  await app.db.setSetting('currencies', [...new Set(codes.filter((c) => CURRENCY_RE.test(c) && c !== BASE))]);
}

let names = null;
// { usd: 'US Dollar', … } for the currency picker (downloaded once per tab; empty when offline).
export async function currencyNames() {
  if (names) return names;
  try { const r = await fetch(NAMES_URL); names = r.ok ? await r.json() : {}; } catch { names = {}; }
  return names;
}

// Income and costs whose rate is provisional and whose date's rate may now be published.
export function pendingFx(ds = app.ds, today = todayISO()) {
  const out = [];
  for (const store of ['income', 'costs']) for (const r of ds[store]) if (isForeign(r) && r.FxStatus === 'provisional') out.push({ store, rec: r, due: r.StartDate <= today });
  return out;
}

let running = null;
// Background job. Returns { finalized, refreshed, pending, error }.
export function syncFx() {
  running ||= (async () => {
    const out = { finalized: 0, refreshed: false, pending: 0, error: null };
    try { await refreshLatest(); out.refreshed = true; } catch (e) { out.error = e.message; }
    const today = todayISO();
    const updates = [];
    for (const { store, rec, due } of pendingFx(app.ds, today)) {
      if (!due) { out.pending++; continue; }
      try {
        const rate = rateFrom(await getDay(rec.StartDate), rec.Currency);
        if (rate !== null) updates.push({ store, id: rec[store === 'income' ? 'IncomeID' : 'CostID'], rate, date: rec.StartDate, status: 'final' });
        else out.pending++;
      } catch (e) { out.pending++; if (!isNotPublished(e)) out.error ||= e.message; }
    }
    if (updates.length) out.finalized = await app.db.applyFxRates(updates);
    return out;
  })().finally(() => { running = null; });
  return running;
}
