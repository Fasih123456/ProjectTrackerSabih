// Exact decimal arithmetic on BigInt. A value is `int / 10^scale`.
// Rounding policy (documented in README): half away from zero.
// Money is stored as 4-decimal strings (Access Currency) and displayed with 2 decimals.

const DEC_RE = /^([+-]?)(\d+)(?:\.(\d+))?$/;
const TEN = 10n;
const pow10 = (n) => TEN ** BigInt(n);

export class Dec {
  constructor(int, scale) { this.i = int; this.s = scale; }

  static zero() { return new Dec(0n, 0); }

  static isDecString(v) { return typeof v === 'string' && DEC_RE.test(v.trim()); }

  // Accepts Dec, decimal string, finite number or bigint. Throws on anything else.
  static from(v) {
    if (v instanceof Dec) return v;
    if (typeof v === 'bigint') return new Dec(v, 0);
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) throw new TypeError('Not a finite number: ' + v);
      let s = String(v);
      if (/e/i.test(s)) s = v.toFixed(20).replace(/\.?0+$/, '');
      return Dec.from(s);
    }
    if (typeof v === 'string') {
      const m = DEC_RE.exec(v.trim());
      if (!m) throw new TypeError('Not a decimal: ' + JSON.stringify(v));
      const frac = m[3] || '';
      let int = BigInt(m[2] + frac);
      if (m[1] === '-') int = -int;
      return new Dec(int, frac.length);
    }
    throw new TypeError('Cannot convert to decimal: ' + v);
  }

  // Null-safe helper: null/undefined stay null.
  static orNull(v) { return v === null || v === undefined ? null : Dec.from(v); }

  static sum(values) { return values.reduce((a, b) => a.add(b), Dec.zero()); }

  #align(o) {
    o = Dec.from(o);
    if (this.s === o.s) return [this.i, o.i, this.s];
    if (this.s > o.s) return [this.i, o.i * pow10(this.s - o.s), this.s];
    return [this.i * pow10(o.s - this.s), o.i, o.s];
  }

  add(o) { const [a, b, s] = this.#align(o); return new Dec(a + b, s); }
  sub(o) { const [a, b, s] = this.#align(o); return new Dec(a - b, s); }
  mul(o) { o = Dec.from(o); return new Dec(this.i * o.i, this.s + o.s).trimScale(12); }
  neg() { return new Dec(-this.i, this.s); }
  abs() { return this.i < 0n ? this.neg() : this; }

  // Division rounded (half away from zero) to `scale` decimals. Returns null on divide-by-zero.
  div(o, scale = 12) {
    o = Dec.from(o);
    if (o.i === 0n) return null;
    // (a/10^sa) / (b/10^sb) = a*10^(sb) / (b*10^sa)
    let num = this.i * pow10(o.s + scale + 1);
    let den = o.i * pow10(this.s);
    if (den < 0n) { num = -num; den = -den; }
    const q = num / den; // truncated toward zero, one extra digit
    return new Dec(q, scale + 1).round(scale);
  }

  // Round half away from zero to `scale` decimals.
  round(scale) {
    if (this.s <= scale) return new Dec(this.i * pow10(scale - this.s), scale);
    const f = pow10(this.s - scale);
    const neg = this.i < 0n;
    const a = neg ? -this.i : this.i;
    let q = a / f;
    if ((a % f) * 2n >= f) q += 1n;
    return new Dec(neg ? -q : q, scale);
  }

  // Limit growth of scale after repeated multiplication without losing meaningful precision.
  trimScale(max) { return this.s > max ? this.round(max) : this; }

  cmp(o) { const [a, b] = this.#align(o); return a < b ? -1 : a > b ? 1 : 0; }
  eq(o) { return this.cmp(o) === 0; }
  lt(o) { return this.cmp(o) < 0; }
  gt(o) { return this.cmp(o) > 0; }
  sign() { return this.i < 0n ? -1 : this.i > 0n ? 1 : 0; }
  isZero() { return this.i === 0n; }

  toFixed(n) {
    const r = this.round(n);
    const neg = r.i < 0n;
    let digits = (neg ? -r.i : r.i).toString();
    if (n === 0) return (neg ? '-' : '') + digits;
    digits = digits.padStart(n + 1, '0');
    const out = digits.slice(0, -n) + '.' + digits.slice(-n);
    return (neg && /[1-9]/.test(out) ? '-' : '') + out;
  }

  // Canonical string without trailing zeros.
  toString() {
    let s = this.toFixed(this.s);
    if (s.includes('.')) s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }

  toNumber() { return Number(this.toString()); }
  toMoney() { return this.toFixed(4); } // Access Currency storage string
}

export const D = (v) => Dec.from(v);
export const roundCurrency4 = (d) => Dec.from(d).round(4);
