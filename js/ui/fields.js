// Labelled form fields with inline validation. Values are parsed only on Submit/preview.
import { h, nextId, replace } from './dom.js';
import { parseMoneyInput, parseNumberInput, parsePercentInput, moneyToInputText, numberToInputText, rateToPercentText, hhmmToDecimal } from '../lib/format.js';
import { isValidISODate } from '../lib/dates.js';
import { BASE_SYMBOL } from '../calc/fx.js';

function toText(f, v) {
  if (v === null || v === undefined) return '';
  if (f.type === 'money') return moneyToInputText(v);
  if (f.type === 'number' || f.type === 'hours') return numberToInputText(v);
  if (f.type === 'percent') return rateToPercentText(v);
  return String(v);
}

function parse(f, input) {
  switch (f.type) {
    case 'checkbox': return { value: input.checked };
    case 'money': return parseMoneyInput(input.value, { allowNegative: f.allowNegative });
    case 'number': case 'hours': return parseNumberInput(input.value, { allowNegative: f.allowNegative });
    case 'percent': return parsePercentInput(input.value);
    case 'date': {
      const t = input.value.trim();
      if (t === '') return { value: null };
      return isValidISODate(t) ? { value: t } : { error: 'Enter a valid date (YYYY-MM-DD)' };
    }
    case 'select': {
      if (input.value === '') return { value: null };
      return { value: f.numeric === false ? input.value : Number(input.value) };
    }
    case 'tags': return { value: f.asText ? (input.selected.length ? input.selected.join(',') : null) : [...input.selected] };
    default: { const t = input.value; return { value: t.trim() === '' ? null : t }; }
  }
}

// Tag picker (type 'tags'): a dropdown that adds the chosen option as a removable tag. The value is the list of
// chosen IDs (numbers), or with f.asText the IDs as "4,7" text (null when none).
const toIds = (v) => (Array.isArray(v) ? v : String(v ?? '').split(',')).map((x) => Number(x)).filter((n) => Number.isSafeInteger(n) && n > 0);
function tagPicker(id, describedBy, f) {
  const box = h('div', { class: 'tagpick', role: 'group', tabindex: '-1', 'aria-describedby': describedBy });
  const list = h('div', { class: 'tag-list' });
  const sel = h('select', { id, 'aria-describedby': describedBy });
  box.append(list, sel);
  box.selected = [];
  let opts = [];
  const labelOf = (v) => opts.find((o) => o.value === v)?.label ?? f.labelOf?.(v) ?? `#${v}`;
  const changed = () => box.dispatchEvent(new Event('change', { bubbles: true }));
  box.render = () => {
    replace(list, box.selected.map((v) => h('span', { class: 'tag' }, labelOf(v),
      h('button', { type: 'button', class: 'tag-remove', 'aria-label': `Remove ${labelOf(v)}`, title: 'Remove', onclick: () => { box.selected = box.selected.filter((x) => x !== v); box.render(); changed(); } }, '×'))));
    const free = opts.filter((o) => !box.selected.includes(o.value));
    const groups = new Map();
    const nodes = [h('option', { value: '' }, free.length ? (box.selected.length ? 'Add another project…' : 'Add a project…') : 'No more projects to add')];
    for (const o of free) {
      const opt = h('option', { value: String(o.value) }, o.label);
      if (o.group) { if (!groups.has(o.group)) { const g = h('optgroup', { label: o.group }); groups.set(o.group, g); nodes.push(g); } groups.get(o.group).append(opt); }
      else nodes.push(opt);
    }
    replace(sel, nodes);
    sel.value = '';
    sel.disabled = !free.length;
  };
  box.setOptions = (o) => { opts = o; box.render(); };
  sel.addEventListener('change', () => { if (sel.value !== '') { box.selected.push(Number(sel.value)); box.render(); } }); // bubbles on to the form
  Object.defineProperty(box, 'value', { get: () => box.selected.join(',') }); // raw text for the dirty check
  return box;
}

// fields: [{name, label, type, required, options(values) -> [{value,label,group}], help, placeholder, hidden(values), readonly, wide}]
export function createForm(fields, initial, { onChange } = {}) {
  const controls = {};
  const el = h('div', { class: 'form-grid' });
  const values = () => {
    const out = {}, errors = {};
    for (const f of fields) {
      const c = controls[f.name];
      if (!c || f.readonly) { out[f.name] = initial[f.name] ?? null; continue; }
      if (c.row.hidden) { out[f.name] = f.hiddenValue !== undefined ? f.hiddenValue : (initial[f.name] ?? null); continue; } // hidden fields keep their stored value
      const p = parse(f, c.input);
      if (p.error) errors[f.name] = p.error;
      else if (f.required && (p.value === null || p.value === undefined)) errors[f.name] = `${f.label} is required`;
      out[f.name] = p.error ? undefined : p.value;
    }
    return { values: out, errors };
  };

  for (const f of fields) {
    const id = nextId('fld');
    const errId = id + '-err', helpId = id + '-help';
    let input;
    const describedBy = [f.help ? helpId : null, errId].filter(Boolean).join(' ');
    if (f.type === 'textarea') input = h('textarea', { id, rows: f.rows || 3, 'aria-describedby': describedBy, placeholder: f.placeholder || null });
    else if (f.type === 'select') input = h('select', { id, 'aria-describedby': describedBy });
    else if (f.type === 'tags') input = tagPicker(id, describedBy, f);
    else if (f.type === 'checkbox') input = h('input', { id, type: 'checkbox', 'aria-describedby': describedBy });
    else if (f.type === 'date') input = h('input', { id, type: 'date', 'aria-describedby': describedBy });
    else input = h('input', { id, type: 'text', autocomplete: 'off', spellcheck: f.type === 'text' || !f.type ? null : 'false', inputmode: ['money', 'number', 'hours', 'percent'].includes(f.type) ? 'decimal' : null, 'aria-describedby': describedBy, placeholder: f.placeholder || null, class: f.mono ? 'mono' : null });
    if (f.readonly) input.disabled = true;
    const suffix = f.type === 'percent' ? h('span', { class: 'suffix' }, '%') : f.type === 'money' ? h('span', { class: 'suffix' }, f.unit || BASE_SYMBOL) : f.type === 'hours' ? h('span', { class: 'suffix' }, 'hours') : f.type === 'number' && f.unit ? h('span', { class: 'suffix' }, f.unit) : null;
    const err = h('div', { class: 'field-error', id: errId, role: 'alert', 'aria-live': 'polite' });
    const label = h('label', { for: id }, f.label, f.required ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);
    let extra = null;
    if (f.type === 'hours') {
      const hm = h('input', { type: 'text', class: 'hhmm', placeholder: 'HH:MM', 'aria-label': `${f.label} as hours:minutes`, inputmode: 'numeric' });
      const conv = h('button', { type: 'button', class: 'btn btn-small', onclick: () => {
        const d = hhmmToDecimal(hm.value);
        if (d === null) { err.textContent = 'Enter time as HH:MM, e.g. 1:30'; return; }
        input.value = String(d); hm.value = ''; err.textContent = ''; changed();
      } }, 'Convert to decimal');
      extra = h('div', { class: 'hhmm-helper' }, hm, conv, h('span', { class: 'muted small' }, 'Optional helper: 1:30 → 1.5 hours. Values are stored as decimal hours.'));
    }
    const row = f.type === 'checkbox'
      ? h('div', { class: `field field-check${f.wide ? ' wide' : ''}` }, h('div', { class: 'check-line' }, input, label), f.help ? h('div', { class: 'help', id: helpId }, f.help) : null, err)
      : h('div', { class: `field${f.wide || f.type === 'textarea' ? ' wide' : ''}` }, label, h('div', { class: 'input-line' }, input, suffix), extra, f.help ? h('div', { class: 'help', id: helpId }, f.help) : null, err);
    controls[f.name] = { f, input, err, row };
    el.append(row);
    input.addEventListener('input', () => changed());
    input.addEventListener('change', () => changed(f.name));
  }

  function fillOptions(current) {
    for (const f of fields) {
      if (f.type === 'tags') {
        const c = controls[f.name];
        const v = current || values().values;
        const exclude = f.exclude ? f.exclude(v) : null; // e.g. the main project cannot also be a split project
        const opts = f.options(v).filter((o) => o.value !== exclude);
        // restrictToOptions: drop picks that are no longer offered (e.g. another client's projects after changing the client)
        c.input.selected = (current !== undefined ? toIds(current[f.name]) : c.input.selected).filter((x, i, a) => x !== exclude && a.indexOf(x) === i && (!f.restrictToOptions || current !== undefined || opts.some((o) => o.value === x)));
        c.input.setOptions(opts);
        continue;
      }
      if (f.type !== 'select') continue;
      const c = controls[f.name];
      const keep = current !== undefined ? current[f.name] : c.input.value;
      const opts = f.options(current || values().values);
      const groups = new Map();
      const nodes = [h('option', { value: '' }, f.placeholder || (f.required ? 'Choose…' : '— None —'))];
      for (const o of opts) {
        const opt = h('option', { value: String(o.value) }, o.label);
        if (o.group) { if (!groups.has(o.group)) { const g = h('optgroup', { label: o.group }); groups.set(o.group, g); nodes.push(g); } groups.get(o.group).append(opt); }
        else nodes.push(opt);
      }
      replace(c.input, nodes);
      c.input.value = keep === null || keep === undefined ? '' : String(keep);
    }
  }

  function refreshVisibility() {
    const v = values().values;
    for (const f of fields) if (f.hidden) controls[f.name].row.hidden = !!f.hidden(v);
  }

  let changing = false;
  function changed(name) {
    if (changing) return;
    changing = true;
    try { refreshVisibility(); onChange?.(api, name); } finally { changing = false; }
  }

  // initial values
  fillOptions(initial);
  for (const f of fields) {
    const c = controls[f.name];
    if (f.type === 'checkbox') c.input.checked = !!initial[f.name];
    else if (f.type !== 'select' && f.type !== 'tags') c.input.value = toText(f, initial[f.name]);
  }
  refreshVisibility();
  // Dirty = any control differs from what was shown when the editor opened (raw text, so blank required fields are not 'changes').
  const raw = () => JSON.stringify(fields.map((f) => { const c = controls[f.name]; return c.row.hidden || f.readonly ? null : f.type === 'checkbox' ? c.input.checked : c.input.value; })); // read-only fields are display only
  const initialSnapshot = raw();

  const api = {
    el, controls,
    values,
    setErrors(map = {}) {
      let first = null;
      for (const [name, c] of Object.entries(controls)) {
        const m = map[name] || '';
        c.err.textContent = m;
        c.input.setAttribute('aria-invalid', m ? 'true' : 'false');
        c.row.classList.toggle('has-error', !!m);
        if (m && !first && !c.row.hidden) first = c.input;
      }
      first?.focus();
      return !!first;
    },
    setValue(name, v) { const c = controls[name]; if (c.f.type === 'checkbox') c.input.checked = !!v; else c.input.value = c.f.type === 'select' ? (v ?? '') : toText(c.f, v); refreshVisibility(); },
    refreshOptions() { fillOptions(); },
    isDirty() { return raw() !== initialSnapshot; },
    focusFirst() { const c = Object.values(controls).find((x) => !x.row.hidden && !x.input.disabled); c?.input.focus(); },
  };
  return api;
}
