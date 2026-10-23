// Employee Bank Details — separate confidential editor using the existing People records.
import { h, replace, toast, icon } from '../dom.js';
import { createForm } from '../fields.js';
import { app } from '../state.js';

let selectedId = null;

export function renderBank(container, params = {}) {
  const people = [...app.ds.people].sort((a, b) => a.PersonName.localeCompare(b.PersonName, undefined, { sensitivity: 'base' }) || a.PersonID - b.PersonID);
  if (params.edit) selectedId = Number(params.edit);
  if (!people.some((p) => p.PersonID === selectedId)) selectedId = people[0]?.PersonID ?? null;

  const head = h('div', { class: 'page-head' },
    h('div', {}, h('div', { class: 'title-row' }, h('h1', {}, 'Employee Bank Details'), h('span', { class: 'badge badge-confidential' }, 'CONFIDENTIAL')),
      h('p', { class: 'lead' }, 'Bank name, account holder name and IBAN for each employee. This information stays on this computer and is never sent anywhere. It does not appear in project or company reports.')),
    h('div', { class: 'page-actions' }, h('a', { class: 'btn', href: '#/reports/bank-details' }, icon.file(), ' Open bank details report')));

  if (!people.length) {
    replace(container, head, h('section', { class: 'card empty-state' }, h('p', {}, 'No employees yet. Add employees under '), h('a', { href: '#/people' }, 'Employees & Rates'), '.'));
    app.editor = null;
    return;
  }

  const msg = h('div', { class: 'form-banner', role: 'alert', hidden: true });
  const select = h('select', { id: 'bank-employee', 'aria-describedby': 'bank-employee-help' }, people.map((p) => h('option', { value: String(p.PersonID) }, p.PersonName)));
  select.value = String(selectedId);
  const formHost = h('div', {});
  let form, person;

  const show = (text, kind = 'warning') => { replace(msg, text); msg.className = `form-banner form-banner-${kind}`; msg.hidden = false; };
  const copyBtn = (label, getText) => h('button', { type: 'button', class: 'btn btn-small btn-copy', onclick: async () => {
    const t = getText();
    if (!t) { toast('Nothing to copy.', 'warn'); return; }
    try { await navigator.clipboard.writeText(t); toast(`${label[0].toUpperCase() + label.slice(1)} copied exactly as stored.`); } catch { toast('Copy failed — select the text and press Ctrl+C.', 'error'); }
  } }, icon.copy(), ` Copy ${label}`);
  const stored = (label, value, cls, copy) => h('div', { class: 'bank-stored-row' },
    h('div', { class: 'bank-stored-text' }, h('span', { class: 'bank-stored-label' }, `${label}:`), value === null || value === undefined || value === ''
      ? h('span', { class: 'muted' }, '— not recorded —') : h('span', { class: `bank-stored-value selectable${cls ? ' ' + cls : ''}` }, value)),
    copy);

  function load() {
    person = app.ds.people.find((p) => p.PersonID === selectedId);
    form = createForm([
      { name: 'BankName', label: 'Bank name', type: 'text', wide: true },
      { name: 'AccountName', label: 'Account holder name', type: 'text', wide: true, help: 'May legitimately differ from the employee name — it is never overwritten automatically.' },
      { name: 'IBAN', label: 'IBAN / account number', type: 'text', mono: true, wide: true, help: 'Stored exactly as typed, including spaces.' },
    ], person);
    replace(formHost,
      h('div', { class: 'bank-meta muted small' }, `Employee #${person.PersonID}: ${person.PersonName}`),
      form.el,
      h('div', { class: 'stored-values bank-stored' },
        h('div', { class: 'bank-stored-title' }, h('span', { class: 'bank-stored-dot', 'aria-hidden': 'true' }), 'Currently stored'),
        stored('Account holder', person.AccountName, '', copyBtn('account name', () => person.AccountName)),
        stored('IBAN', person.IBAN, 'mono', copyBtn('IBAN', () => person.IBAN))));
    app.editor = { page: true, isDirty: () => form.isDirty(), discard: () => { app.editor = null; }, externalChange: () => {
      const now = app.ds.people.find((p) => p.PersonID === selectedId);
      if (!now) show('This employee was deleted in another tab. Cancel to reload.');
      else if (now.revision !== person.revision) { if (form.isDirty()) show('These bank details were changed in another tab. Submitting will be refused; press Cancel to load the latest values.'); else { msg.hidden = true; load(); } }
    } };
  }

  select.addEventListener('change', () => {
    if (form.isDirty()) {
      select.value = String(selectedId);
      show('Press Submit or Cancel before changing employees. Your unsaved edits are still in the form.');
      form.focusFirst();
      return;
    }
    msg.hidden = true;
    selectedId = Number(select.value);
    load();
  });

  const submit = h('button', { type: 'button', class: 'btn btn-primary', onclick: async () => {
    msg.hidden = true;
    const { values } = form.values();
    if (!form.isDirty()) { toast('No changes to save.', 'info'); return; }
    submit.disabled = true; submit.textContent = 'Saving…';
    try {
      await app.db.update('people', { ...person, ...values }, person.revision);
      await app.reload();
      app.render(); // refresh the summary cards as well as the form
      toast('Bank details saved.');
    } catch (e) { show(e.message, 'error'); submit.disabled = false; submit.textContent = 'Submit'; }
  } }, 'Submit');
  const cancel = h('button', { type: 'button', class: 'btn', onclick: async () => { msg.hidden = true; await app.reload(); load(); toast('Changes discarded. Stored values reloaded.', 'info'); } }, 'Cancel');

  replace(container, head,
    h('section', { class: 'card bank-card' },
      h('div', { class: 'field bank-employee' }, h('label', { for: 'bank-employee' }, 'Employee'), select, h('div', { class: 'help', id: 'bank-employee-help' }, 'Sorted by name. Press Submit or Cancel before switching.')),
      msg, formHost,
      h('div', { class: 'form-actions bank-actions' }, h('span', { class: 'muted small' }, 'Nothing is saved until you press Submit.'), cancel, submit)));
  load();
}
