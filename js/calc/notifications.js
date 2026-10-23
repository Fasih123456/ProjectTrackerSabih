// In-app notifications: which ones are due, and merging them into the stored list (pure, no storage access).
// Each notification has a stable `key`, so the same event is only ever notified once (even across tabs/reloads).
import { Dec } from '../lib/decimal.js';
import { fmtMoney } from '../lib/format.js';
import { buildIndex, projectLabel, clientNameById } from './calc.js';
import { clauseStatus, clauseEndDate, renewalDecisionDate } from './contracts.js';

export const APPROVAL_LEAD_DAYS = 14;   // notify when a renewal approval is due within 2 weeks
const LOOKBACK_DAYS = 30;               // don't notify about things that happened more than a month ago
export const MAX_KEPT = 300;            // stored notifications (oldest dropped first)
export const YEAR_END_DAY = '01-24';    // every 24 January

const days = (from, to) => Math.round((Date.parse(to) - Date.parse(from)) / 86400000);

// Notifications that follow from the data and today's date. Returns [{ key, type, title, body, link }].
export function dueNotifications(ds, today) {
  const idx = buildIndex(ds);
  const out = [];
  // 1. Contract clause renewal approval needed within 2 weeks (or overdue for at most a month while still running).
  for (const k of ds.clauses || []) {
    if (clauseStatus(k, today) !== 'Active') continue;
    const date = renewalDecisionDate(k) ?? clauseEndDate(k);
    if (!date) continue;
    const d = days(today, date);
    if (d > APPROVAL_LEAD_DAYS || d < -LOOKBACK_DAYS) continue;
    const c = (ds.contracts || []).find((x) => x.ContractID === k.ContractID);
    const where = c ? `${clientNameById(idx, c.ClientID)} / ${c.ContractName}` : `Contract #${k.ContractID}`;
    out.push({
      key: `approval:${k.ClauseID}:${date}`, type: 'approval',
      title: d < 0 ? 'Renewal approval overdue' : 'Renewal approval due within 2 weeks',
      body: `${where} — ${k.ClauseTitle}: client approval needed by ${date}${clauseEndDate(k) ? ` (clause ends ${clauseEndDate(k)})` : ''}.`,
      link: `#/clauses?contract=${k.ContractID}`,
    });
  }
  // 2. Year end reminder, every 24 January (shown once a year; if the app is first opened later in January it still appears).
  const year = today.slice(0, 4);
  if (today.slice(5) >= YEAR_END_DAY && today.slice(5, 7) === '01') {
    out.push({
      key: `year-end:${year}`, type: 'year-end', title: 'Company year end is soon',
      body: `It is ${year}-${YEAR_END_DAY}: Engineered Plans' year end is coming up. Review income, costs and contracts in Reports, and export a backup.`,
      link: '#/reports',
    });
  }
  // 3. Recurring rule became inactive because its end date has passed (within the last month).
  for (const r of ds.recurring || []) {
    if (!r.EndDate || r.EndDate >= today || days(r.EndDate, today) > LOOKBACK_DAYS) continue;
    out.push({
      key: `recurring-ended:${r.RecurringID}:${r.EndDate}`, type: 'recurring-ended',
      title: `Recurring ${r.Kind === 'Income' ? 'income' : 'cost'} ended: ${r.Name}`,
      body: `${projectLabel(idx, r.ProjectID)} — its end date ${r.EndDate} has passed, so it is now inactive and no further entries will be added.`,
      link: '#/recurring',
    });
  }
  return out;
}

// One notification per rule for entries the recurring generator just added (summary from db.generateRecurring).
export function recurringCreatedNotifications(rules, ds) {
  const idx = buildIndex(ds);
  return (rules || []).filter((s) => s.ids.length).map((s) => {
    const n = s.ids.length, total = Dec.sum(s.amounts.map((a) => Dec.from(a)));
    const where = s.projectIds.map((pid) => projectLabel(idx, pid)).join(', ');
    const when = s.dates.length === 1 ? s.dates[0] : `${s.dates.length} dates (${s.dates[0]} … ${s.dates[s.dates.length - 1]})`;
    return {
      key: `recurring-created:${s.ruleId}:${s.ids[0]}`, type: 'recurring-created',
      title: `Recurring ${s.kind === 'Income' ? 'income' : 'cost'} added: ${s.name}`,
      body: `${n} entr${n === 1 ? 'y' : 'ies'} totalling ${fmtMoney(total)} for ${where}, dated ${when}.`,
      link: s.kind === 'Income' ? '#/income' : '#/costs',
    };
  });
}

// Adds the incoming notifications whose key is new (unread, stamped `now`). Returns the new list, or null if nothing
// was added. Newest first; at most MAX_KEPT kept.
export function mergeNotifications(existing, incoming, now = new Date().toISOString()) {
  const seen = new Set(existing.map((n) => n.key));
  const fresh = [];
  for (const n of incoming) if (!seen.has(n.key)) { seen.add(n.key); fresh.push({ ...n, createdAt: now, read: false, dismissed: false }); }
  if (!fresh.length) return null;
  return [...fresh.reverse(), ...existing].slice(0, MAX_KEPT);
}

export const visibleNotifications = (list) => list.filter((n) => !n.dismissed);
export const unreadCount = (list) => list.filter((n) => !n.dismissed && !n.read).length;
