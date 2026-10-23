// Minimal in-browser test harness. Results are written to #results and document.title for headless runs.
const tests = [];
export function test(name, fn) { tests.push({ name, fn }); }
export function assert(cond, msg = 'assertion failed') { if (!cond) throw new Error(msg); }
export function eq(actual, expected, msg = '') {
  const a = actual?.toString?.() ?? String(actual), e = expected?.toString?.() ?? String(expected);
  if (actual === null && expected !== null) throw new Error(`${msg} expected ${e}, got null`);
  if (a !== e) throw new Error(`${msg} expected ${e}, got ${a}`);
}
export async function rejects(p, pattern, msg = '') {
  try { await p; } catch (e) { if (pattern && !pattern.test(e.name + ' ' + e.message + ' ' + JSON.stringify(e.fields || {}))) throw new Error(`${msg} wrong error: ${e.name}: ${e.message} ${JSON.stringify(e.fields || {})}`); return e; }
  throw new Error(`${msg} expected rejection`);
}

export async function run() {
  const out = document.getElementById('results');
  let pass = 0, fail = 0;
  const lines = [];
  for (const t of tests) {
    try { const r = await t.fn(); if (r === 'SKIP') lines.push(`SKIP  ${t.name}`); else { pass++; lines.push(`PASS  ${t.name}`); } }
    catch (e) { fail++; lines.push(`FAIL  ${t.name}\n      ${e.message}\n${(e.stack || '').split('\n').slice(1, 3).join('\n')}`); }
    out.textContent = lines.join('\n');
  }
  lines.push(`\n${pass} passed, ${fail} failed`);
  out.textContent = lines.join('\n');
  document.title = `DONE ${pass} passed ${fail} failed`;
  document.body.dataset.done = fail ? 'fail' : 'pass';
}
