// DOM helpers. All user text is inserted as text nodes (never as HTML).

export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden' || k === 'required' || k === 'readOnly') el[k] = !!v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.firstChild.remove(); return el; }
export function replace(el, ...children) { clear(el); append(el, children); return el; }

let uid = 0;
export const nextId = (p = 'f') => `${p}-${++uid}`;

// ---------- toasts ----------
export function toast(message, kind = 'ok', ms = 3500) {
  const host = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${kind}`, role: kind === 'error' ? 'alert' : 'status' }, message);
  host.append(t);
  setTimeout(() => t.remove(), ms);
}

// ---------- dialogs ----------
// Opens a modal <dialog>. `onCancelRequest` decides what Escape does (return false to keep it open).
export function openDialog({ title, body, footer, wide = false, onCancelRequest, labelledBy }) {
  const titleId = nextId('dlg');
  const dlg = h('dialog', { class: `dialog${wide ? ' dialog-wide' : ''}`, 'aria-labelledby': labelledBy || titleId },
    h('div', { class: 'dialog-head' }, h('h2', { id: titleId }, title)),
    h('div', { class: 'dialog-body' }, body),
    footer ? h('div', { class: 'dialog-foot' }, footer) : null);
  dlg.addEventListener('cancel', async (e) => {
    e.preventDefault();
    if (!onCancelRequest || (await onCancelRequest()) !== false) close();
  });
  document.body.append(dlg);
  dlg.showModal();
  const prevFocus = document.activeElement;
  function close() { dlg.close(); dlg.remove(); if (prevFocus && prevFocus.focus && document.contains(prevFocus)) prevFocus.focus(); }
  return { dlg, close };
}

// In-page confirmation (never window.confirm). Resolves true/false.
export function confirmDialog(message, { title = 'Please confirm', ok = 'OK', cancel = 'Cancel', danger = false, details = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const okBtn = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', onclick: () => finish(true) }, ok);
    const d = openDialog({
      title,
      body: h('div', {}, h('p', {}, message), details),
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => finish(false) }, cancel), okBtn],
      onCancelRequest: () => { finish(false); return false; },
    });
    okBtn.focus();
  });
}

// In-page choice between several actions. choices: [{ label, value, kind: 'primary' | 'danger' | undefined }].
// Resolves the chosen value, or null on Cancel / Escape.
export function choiceDialog(message, { title = 'Choose an option', choices = [], cancel = 'Cancel', details = null } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; d.close(); resolve(v); };
    const btns = choices.map((c) => h('button', { class: `btn${c.kind ? ' btn-' + c.kind : ''}`, type: 'button', onclick: () => finish(c.value) }, c.label));
    const d = openDialog({
      title,
      body: h('div', {}, h('p', {}, message), details),
      footer: [h('button', { class: 'btn', type: 'button', onclick: () => finish(null) }, cancel), ...btns],
      onCancelRequest: () => { finish(null); return false; },
    });
    btns[btns.length - 1]?.focus();
  });
}

export function alertDialog(message, { title = 'Notice', details = null } = {}) {
  return new Promise((resolve) => {
    const btn = h('button', { class: 'btn btn-primary', type: 'button', onclick: () => { d.close(); resolve(); } }, 'OK');
    const d = openDialog({ title, body: h('div', {}, h('p', {}, message), details), footer: [btn], onCancelRequest: () => { resolve(); return true; } });
    btn.focus();
  });
}

export const icon = {
  plus: () => svg('M12 5v14M5 12h14'),
  edit: () => svg('M4 20h4l10-10-4-4L4 16v4zM13 7l4 4'),
  trash: () => svg('M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13'),
  download: () => svg('M12 4v11M7 10l5 5 5-5M5 20h14'),
  print: () => svg('M7 9V4h10v5M7 17H5v-6h14v6h-2M7 14h10v6H7z'),
  copy: () => svg('M9 9h10v11H9zM5 15V4h10'),
  archive: () => svg('M4 5h16v4H4zM6 9v10h12V9M10 13h4'),
  bell: () => svg('M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 21h4'),
  list: () => svg('M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01'),
  book: () => svg('M4 19.5A2.5 2.5 0 0 1 6.5 17H20V3H6.5A2.5 2.5 0 0 0 4 5.5zM4 19.5A2.5 2.5 0 0 0 6.5 22H20v-5M8 7h8M8 11h6'),
  // Navigation and dashboard icons (outlined, 24px grid).
  dashboard: () => svg('M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 16h7v5H3z'),
  clients: () => svg('M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'),
  contract: () => svg('M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9zM14 3v6h6M8 13h8M8 17h5'),
  gavel: () => svg('M14 13l-7.5 7.5a2.12 2.12 0 0 1-3-3L11 10M16 16l6-6M8 8l6-6M9 7l8 8M21 11l-8-8'),
  folder: () => svg('M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z'),
  payments: () => svg('M2 6h20v12H2zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 12h.01M18 12h.01'),
  clock: () => svg('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2'),
  receipt: () => svg('M5 3v18l2.5-1.5L10 21l2-1.5 2 1.5 2.5-1.5L19 21V3l-2.5 1.5L14 3l-2 1.5L10 3 7.5 4.5zM9 9h6M9 13h6'),
  sync: () => svg('M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2M18.5 2v4h-4M5.5 22v-4h4'),
  badge: () => svg('M3 5h18v14H3zM9 11a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 16a3.5 3.5 0 0 1 7 0M15 9h3M15 13h3'),
  headset: () => svg('M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1zM20 14h-3v5h2a1 1 0 0 0 1-1zM17 19a4 4 0 0 1-4 3h-1'),
  history: () => svg('M3 12a9 9 0 1 0 3-6.7L3 8M3 3v5h5M12 7v5l3 2'),
  register: () => svg('M3 9h18v11H3zM6 9V4h9v5M3 14h18M7 17h2M11 17h2'),
  personAdd: () => svg('M15 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M8.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM20 8v6M23 11h-6'),
  bank: () => svg('M3 21h18M4 10h16M12 3l9 5H3zM6 10v8M10 10v8M14 10v8M18 10v8'),
  analytics: () => svg('M3 3h18v18H3zM8 16v-4M12 16V8M16 16v-6'),
  restore: () => svg('M3 12a9 9 0 1 0 2.6-6.4L3 8M3 3v5h5M9 12h6M12 9v6'),
  gear: () => svg('M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z'),
  help: () => svg('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01'),
  wallet: () => svg('M20 7V4H5a2 2 0 0 0 0 4h15v12H5a2 2 0 0 1-2-2V6M16 14h.01'),
  upload: () => svg('M16 16l-4-4-4 4M12 12v9M20.4 18.4A5 5 0 0 0 18 9h-1.3A8 8 0 1 0 4 16.3'),
  arrowRight: () => svg('M5 12h14M13 6l6 6-6 6'),
  play: () => svg('M7 4.5v15l12.5-7.5z'),
  clip: () => svg('M21 11.5l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.6-8.6a3.3 3.3 0 0 1 4.7 4.7l-8.6 8.6a1.7 1.7 0 0 1-2.4-2.4l7.9-7.9'),
  image: () => svg('M4 4h16v16H4zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM20 15l-5-5L5 20'),
  // Summary-card and filter icons for the list screens.
  money: () => svg('M12 6v12M15 9.5c0-1.4-1.3-2.5-3-2.5s-3 1-3 2.3c0 3 6 1.7 6 4.7 0 1.4-1.3 2.5-3 2.5s-3-1.1-3-2.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0z'),
  file: () => svg('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M9 13h6M9 17h4'),
  bars: () => svg('M5 20v-7M12 20V8M19 20V4M3 20h18'),
  clipboard: () => svg('M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2'),
  users: () => svg('M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 10a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.87M16 4.13a3 3 0 0 1 0 5.74'),
  building: () => svg('M4 21V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v16M16 9h2a2 2 0 0 1 2 2v10M2 21h20M8 7h1M8 11h1M8 15h1M12 7h1M12 11h1M12 15h1'),
  trend: () => svg('M3 17l6-6 4 4 8-8M15 7h6v6'),
  search: () => svg('M21 21l-5-5M10 17a7 7 0 1 1 0-14 7 7 0 0 1 0 14z'),
  calendar: () => svg('M7 3v3M17 3v3M4 6h16v14H4zM4 10h16'),
  store: () => svg('M4 10v10h16V10M3 4h18l-1 6H4zM9 20v-6h6v6'),
  tag: () => svg('M3 12V4h8l10 10-8 8zM7.5 8.5h.01'),
  chevronLeft: () => svg('M15 6l-6 6 6 6'),
  chevronRight: () => svg('M9 6l6 6-6 6'),
  // Bank, costs, recurring, salespeople and settings screens.
  database: () => svg('M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3zM4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3'),
  cloudDown: () => svg('M12 13v8M8 17l4 4 4-4M20.4 16.4A5 5 0 0 0 18 7h-1.3A8 8 0 1 0 4 14.3'),
  fileImport: () => svg('M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5M12 11v6M9 14l3 3 3-3'),
  palette: () => svg('M12 22a10 10 0 1 1 10-10c0 2.8-2.2 4-4 4h-2a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01'),
  info: () => svg('M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01'),
  shieldCheck: () => svg('M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10zM9 12l2 2 4-4'),
  sitemap: () => svg('M9 3h6v5H9zM3 16h6v5H3zM15 16h6v5h-6zM12 8v4M6 16v-4h12v4'),
  creditCard: () => svg('M3 5h18v14H3zM3 10h18M7 15h2M11 15h2'),
  arrowUp: () => svg('M12 19V5M5 12l7-7 7 7'),
  arrowDown: () => svg('M12 5v14M19 12l-7 7-7-7'),
  flask: () => svg('M9 3h6M10 3v6l-5.5 9.5A1.7 1.7 0 0 0 6 21h12a1.7 1.7 0 0 0 1.5-2.5L14 9V3M7 15h10'),
  send: () => svg('M22 2L11 13M22 2l-7 20-4-9-9-4z'),
  external: () => svg('M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'),
  checkCircle: () => svg('M22 12a10 10 0 1 1-20 0 10 10 0 0 1 20 0zM8 12l3 3 5-5'),
  sliders: () => svg('M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'),
};
function svg(d) {
  const ns = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(ns, 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', '16'); s.setAttribute('height', '16'); s.setAttribute('aria-hidden', 'true'); s.setAttribute('class', 'icon');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', d); p.setAttribute('fill', 'none'); p.setAttribute('stroke', 'currentColor'); p.setAttribute('stroke-width', '2'); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('stroke-linejoin', 'round');
  s.append(p);
  return s;
}
