// Timezone-independent calendar dates stored as 'YYYY-MM-DD'.
// Day arithmetic uses UTC milliseconds so daylight-saving transitions never shift a date.

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidISODate(s) {
  if (typeof s !== 'string') return false;
  const m = ISO_RE.exec(s);
  if (!m) return false;
  const y = +m[1], mo = +m[2], d = +m[3];
  if (y < 1900 || y > 9999 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonth(y, mo);
}

export function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

export function addDays(iso, n) {
  const m = ISO_RE.exec(iso);
  if (!m) throw new TypeError('Invalid date: ' + iso);
  const t = Date.UTC(+m[1], +m[2] - 1, +m[3]) + n * 86400000;
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

// Today's local calendar date (the user's wall clock), not a UTC conversion.
export function todayISO(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

export const monthOf = (iso) => iso ? iso.slice(0, 7) : null;

export function monthLabel(ym) {
  if (!ym) return '';
  const [y, m] = ym.split('-');
  return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][+m - 1]} ${y}`;
}

// Inclusive range check on ISO strings; empty bounds are open.
export function inRange(iso, from, to) {
  if (!iso) return false;
  if (from && iso < from) return false;
  if (to && iso > to) return false;
  return true;
}

export function firstOfMonth(iso) { return iso.slice(0, 8) + '01'; }
export function lastOfMonth(iso) { const y = +iso.slice(0, 4), m = +iso.slice(5, 7); return `${iso.slice(0, 8)}${String(daysInMonth(y, m)).padStart(2, '0')}`; }
