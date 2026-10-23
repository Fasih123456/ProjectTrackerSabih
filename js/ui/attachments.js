// Receipts (costs) and invoices (income) inside the record editor. Like the rest of the form, nothing is stored until
// Submit: files added or removed here are kept in the editor and applied by commit(saved) after the record is saved.
// Recurring rules have no attachments; the income/cost records they create can have them like any other record.
import { h, replace, toast, icon } from './dom.js';
import { app } from './state.js';
import { STORES, MAX_ATTACHMENT_BYTES } from '../model/schema.js';
import { fmtBytes } from '../lib/format.js';

export const ATTACH_KIND = {
  costs: { one: 'receipt', many: 'receipts', title: 'Receipts' },
  income: { one: 'invoice', many: 'invoices', title: 'Invoices' },
};
const ACCEPT = 'image/*,application/pdf,.pdf,.png,.jpg,.jpeg,.webp,.heic,.gif';

export const attachmentsOf = (store, recordId) => (app.ds.attachments || []).filter((a) => a.Store === store && a.RecordID === recordId);
// Number of attachments per record ID of a store (for list columns).
export function attachmentCounts(store) {
  const m = new Map();
  for (const a of app.ds.attachments || []) if (a.Store === store) m.set(a.RecordID, (m.get(a.RecordID) || 0) + 1);
  return m;
}

// Opens a stored file in a new tab (images and PDFs show in the browser; other types download).
export async function openAttachment(a) {
  const tab = window.open('', '_blank');
  try {
    const blob = await app.db.getFile(a.AttachmentID);
    if (!blob) throw new Error('The file contents are missing.');
    const url = URL.createObjectURL(blob.type ? blob : new Blob([blob], { type: a.MimeType }));
    if (tab) tab.location.href = url; else window.location.assign(url);
    setTimeout(() => URL.revokeObjectURL(url), 5 * 60 * 1000);
  } catch (e) { tab?.close(); toast(`Could not open ${a.FileName}: ${e.message}`, 'error', 7000); }
}
async function downloadAttachment(a) {
  const blob = await app.db.getFile(a.AttachmentID);
  if (!blob) { toast(`The contents of ${a.FileName} are missing.`, 'error'); return; }
  const url = URL.createObjectURL(blob);
  const link = h('a', { href: url, download: a.FileName });
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60 * 1000);
}

const fileIcon = (type) => (/^image\//.test(type) ? icon.image() : icon.file());

// The editor section. Returns { el, isDirty(), commit(savedRecord) }.
export function attachmentsEditor(store, existing) {
  const kind = ATTACH_KIND[store];
  const stored = existing ? attachmentsOf(store, existing[STORES[store].key]) : [];
  const removed = new Set(); // AttachmentIDs to delete on Submit
  const added = []; // File objects to add on Submit
  const list = h('ul', { class: 'att-list' });
  const input = h('input', { type: 'file', multiple: true, accept: ACCEPT, class: 'sr-only', tabindex: '-1', 'aria-hidden': 'true', onchange: () => { take([...input.files]); input.value = ''; } });
  const pick = h('button', { type: 'button', class: 'btn btn-small', onclick: () => input.click() }, icon.clip(), ` Attach ${kind.one}`);
  const box = h('section', { class: 'att-box', 'aria-label': kind.title,
    ondragover: (e) => { e.preventDefault(); box.classList.add('drag'); }, ondragleave: () => box.classList.remove('drag'),
    ondrop: (e) => { e.preventDefault(); box.classList.remove('drag'); take([...(e.dataTransfer?.files || [])]); } },
  h('div', { class: 'att-head' },
    h('div', {}, h('h3', {}, kind.title), h('p', { class: 'muted small' }, `PDF or image, up to ${fmtBytes(MAX_ATTACHMENT_BYTES)} each. Drop files here or use the button. Saved when you press Submit.`)),
    pick, input),
  list);

  function take(files) {
    for (const f of files) {
      if (f.size > MAX_ATTACHMENT_BYTES) { toast(`${f.name} is ${fmtBytes(f.size)}; the limit is ${fmtBytes(MAX_ATTACHMENT_BYTES)} per file.`, 'error', 7000); continue; }
      if (!f.size) { toast(`${f.name} is empty.`, 'error'); continue; }
      added.push(f);
    }
    draw();
  }
  function draw() {
    const rows = [
      ...stored.map((a) => {
        const gone = removed.has(a.AttachmentID);
        return h('li', { class: `att-item${gone ? ' att-removed' : ''}` },
          h('span', { class: 'att-ico', 'aria-hidden': 'true' }, fileIcon(a.MimeType)),
          h('button', { type: 'button', class: 'att-name', title: `Open ${a.FileName}`, disabled: gone, onclick: () => openAttachment(a) }, a.FileName),
          h('span', { class: 'att-size muted small' }, gone ? 'removed on Submit' : fmtBytes(a.Size)),
          gone ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => { removed.delete(a.AttachmentID); draw(); } }, 'Undo')
            : [h('button', { type: 'button', class: 'btn-icon', title: 'Download', 'aria-label': `Download ${a.FileName}`, onclick: () => downloadAttachment(a) }, icon.download()),
              h('button', { type: 'button', class: 'btn-icon btn-icon-danger', title: 'Remove', 'aria-label': `Remove ${a.FileName}`, onclick: () => { removed.add(a.AttachmentID); draw(); } }, icon.trash())]);
      }),
      ...added.map((f, i) => h('li', { class: 'att-item att-new' },
        h('span', { class: 'att-ico', 'aria-hidden': 'true' }, fileIcon(f.type)),
        h('span', { class: 'att-name' }, f.name),
        h('span', { class: 'att-size muted small' }, `${fmtBytes(f.size)} · added on Submit`),
        h('button', { type: 'button', class: 'btn-icon btn-icon-danger', title: 'Remove', 'aria-label': `Remove ${f.name}`, onclick: () => { added.splice(i, 1); draw(); } }, icon.trash()))),
    ];
    replace(list, rows.length ? rows : h('li', { class: 'att-empty muted small' }, `No ${kind.many} attached.`));
  }
  draw();

  return {
    el: box,
    isDirty: () => removed.size > 0 || added.length > 0,
    async commit(saved) {
      const id = saved[STORES[store].key];
      if (removed.size) await app.db.removeAttachments([...removed]);
      if (added.length) await app.db.addAttachments(store, id, added.map((f) => ({ name: f.name, type: f.type, size: f.size, blob: f })));
    },
  };
}
