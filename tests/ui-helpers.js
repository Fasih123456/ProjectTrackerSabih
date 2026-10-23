// Helpers injected into the app page by ui-smoke.ps1 (test use only).
window.T = {
  q: (s) => document.querySelector(s),
  dlg: () => document.querySelector('dialog[open]'),
  btn: (text, root = document) => [...root.querySelectorAll('button,a')].find((b) => b.textContent.trim() === text || b.textContent.trim().endsWith(text)),
  field: (label) => { const d = document.querySelector('dialog[open]') || document; const l = [...d.querySelectorAll('label')].find((x) => x.textContent.replace('*', '').trim().startsWith(label)); return l && document.getElementById(l.htmlFor); },
  set: (label, value) => { const el = T.field(label); if (!el) throw new Error('no field ' + label); if (el.tagName === 'SELECT') { const o = [...el.options].find((o) => o.textContent === value || o.value === String(value)); if (!o) throw new Error('no option ' + value + ' in ' + label); el.value = o.value; } else if (el.type === 'checkbox') el.checked = !!value; else el.value = value; el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); },
  wait: (fn, ms = 5000) => new Promise((res, rej) => { const t0 = Date.now(); const tick = () => { let v; try { v = fn(); } catch (e) { v = null; } if (v) res(v); else if (Date.now() - t0 > ms) rej(new Error('timeout ' + fn)); else setTimeout(tick, 50); }; tick(); }),
  go: async (hash) => { location.hash = hash; await new Promise((r) => setTimeout(r, 150)); },
  rows: () => [...document.querySelectorAll('#view table.data tbody tr')].filter((r) => !r.querySelector('td.empty')).length,
  text: () => document.getElementById('view').innerText,
  add: async (hash, addText, fields) => { await T.go(hash); T.btn(addText).click(); await T.wait(() => T.dlg()); for (const [k, v] of fields) T.set(k, v); T.btn('Submit', T.dlg()).click(); await T.wait(() => !T.dlg(), 5000); await new Promise((r) => setTimeout(r, 100)); },
};
