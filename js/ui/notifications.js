// Header bell: unread count and a drop-down list of notifications with date and time.
import { h, replace, icon } from './dom.js';
import { app } from './state.js';
import { fmtDateTime } from '../lib/format.js';
import { todayISO } from '../lib/dates.js';
import { dueNotifications, recurringCreatedNotifications, mergeNotifications, visibleNotifications, unreadCount } from '../calc/notifications.js';

let list = [];
let bell, badge, panel;
let syncing = null;

// Adds any newly due notifications (plus `extra`, e.g. recurring entries just created) and redraws the bell.
// Runs one at a time; reads the database afresh so it never works from a stale snapshot.
export function syncNotifications(extra = []) {
  const run = async () => {
    try {
      const ds = await app.db.loadAll();
      const incoming = [...dueNotifications(ds, todayISO()), ...extra];
      list = await app.db.updateNotifications((cur) => mergeNotifications(cur, incoming));
      draw();
    } catch (e) { console.error('Notifications could not be updated', e); }
  };
  syncing = (syncing || Promise.resolve()).then(run);
  return syncing;
}

// Recurring-generator result -> notification per rule that got new entries.
export async function notifyRecurringCreated(result) {
  if (!result?.rules?.length) return;
  const ds = await app.db.loadAll();
  await syncNotifications(recurringCreatedNotifications(result.rules, ds));
}

// Settings → "Send a test notification": a unique, unread sample so the bell can be tried out.
export function sendTestNotification() {
  return syncNotifications([{ key: `test:${Date.now()}`, type: 'test', title: 'Test notification',
    body: 'This is how notifications look. Click one to open the related screen, × to dismiss it, or use Mark all read / Clear all above.', link: '#/settings' }]);
}

// Another tab changed the list: just re-read it.
export async function refreshNotifications() {
  list = (await app.db.getMeta('notifications')) || [];
  draw();
}

const update = (fn) => app.db.updateNotifications(fn).then((l) => { list = l; draw(); });
const markRead = (key) => update((cur) => cur.map((n) => (n.key === key ? { ...n, read: true } : n)));
const dismiss = (key) => update((cur) => cur.map((n) => (n.key === key ? { ...n, dismissed: true, read: true } : n)));
const markAllRead = () => update((cur) => (cur.some((n) => !n.read) ? cur.map((n) => ({ ...n, read: true })) : null));
const clearAll = () => update((cur) => cur.map((n) => ({ ...n, dismissed: true, read: true })));

const TYPE_LABEL = { approval: 'Renewal', 'year-end': 'Year end', 'recurring-created': 'Recurring', 'recurring-ended': 'Recurring', test: 'Test' };

function draw() {
  if (!bell) return;
  const unread = unreadCount(list);
  badge.textContent = unread > 99 ? '99+' : String(unread);
  badge.hidden = unread === 0;
  bell.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');
  if (panel.hidden) return;
  const items = visibleNotifications(list);
  replace(panel,
    h('div', { class: 'notif-head' }, h('strong', {}, 'Notifications'),
      h('span', { class: 'notif-actions' },
        h('button', { type: 'button', class: 'btn btn-small', disabled: !unread, onclick: markAllRead }, 'Mark all read'),
        h('button', { type: 'button', class: 'btn btn-small', disabled: !items.length, onclick: clearAll }, 'Clear all'))),
    items.length
      ? h('ul', { class: 'notif-list' }, items.map((n) => h('li', { class: `notif-item notif-${n.type}${n.read ? '' : ' unread'}` },
        h('button', { type: 'button', class: 'notif-open', onclick: () => { markRead(n.key); close(); if (n.link) location.hash = n.link; } },
          h('span', { class: 'notif-meta' }, h('span', { class: 'notif-type' }, TYPE_LABEL[n.type] || 'Notice'), ' · ', h('time', { datetime: n.createdAt }, fmtDateTime(n.createdAt))),
          h('span', { class: 'notif-title' }, n.title),
          h('span', { class: 'notif-body' }, n.body)),
        h('button', { type: 'button', class: 'notif-dismiss', title: 'Dismiss', 'aria-label': `Dismiss: ${n.title}`, onclick: () => dismiss(n.key) }, '×'))))
      : h('p', { class: 'notif-empty' }, 'No notifications.'));
}

function open() { panel.hidden = false; bell.setAttribute('aria-expanded', 'true'); draw(); }
function close() { if (panel.hidden) return; panel.hidden = true; bell.setAttribute('aria-expanded', 'false'); }

// Builds the bell into the header (before the Backup button) and loads the stored list.
export async function initNotifications() {
  const host = document.getElementById('header-right');
  badge = h('span', { class: 'notif-badge', hidden: true });
  bell = h('button', { type: 'button', class: 'btn notif-bell', id: 'notif-bell', 'aria-haspopup': 'true', 'aria-expanded': 'false', 'aria-controls': 'notif-panel', title: 'Notifications',
    onclick: (e) => { e.stopPropagation(); if (panel.hidden) open(); else close(); } }, icon.bell(), badge);
  panel = h('div', { class: 'notif-panel', id: 'notif-panel', role: 'region', 'aria-label': 'Notifications', hidden: true });
  panel.addEventListener('click', (e) => e.stopPropagation());
  host.prepend(h('div', { class: 'notif-wrap' }, bell, panel));
  document.addEventListener('click', close);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !panel.hidden) { close(); bell.focus(); } });
  await refreshNotifications();
}
