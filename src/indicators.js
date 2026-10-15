// Technical indicators + a registry describing how each one is drawn.
// Candles: [{time, open, high, low, close, volume}]. Outputs are [{time, value}] point arrays.

const pts = (candles, values) => candles.map((c, i) => (values[i] == null || Number.isNaN(values[i]) ? null : { time: c.time, value: values[i] })).filter(Boolean);
const closes = (c) => c.map((x) => x.close);

export function smaValues(v, n) {
  const out = new Array(v.length).fill(null);
  let s = 0;
  for (let i = 0; i < v.length; i++) {
    s += v[i];
    if (i >= n) s -= v[i - n];
    if (i >= n - 1) out[i] = s / n;
  }
  return out;
}

export function emaValues(v, n) {
  const k = 2 / (n + 1), out = new Array(v.length).fill(null);
  let prev = null, seed = 0, count = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) continue;
    if (prev == null) {
      seed += v[i]; count++;
      if (count === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = v[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA). */
function rmaValues(v, n) {
  const out = new Array(v.length).fill(null);
  let prev = null, seed = 0, count = 0;
  for (let i = 0; i < v.length; i++) {
    if (v[i] == null) continue;
    if (prev == null) {
      seed += v[i]; count++;
      if (count === n) { prev = seed / n; out[i] = prev; }
      continue;
    }
    prev = (prev * (n - 1) + v[i]) / n;
    out[i] = prev;
  }
  return out;
}

function wmaValues(v, n) {
  const out = new Array(v.length).fill(null), denom = (n * (n + 1)) / 2;
  for (let i = n - 1; i < v.length; i++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += v[i - j] * (n - j);
    out[i] = s / denom;
  }
  return out;
}

function stdevValues(v, n) {
  const out = new Array(v.length).fill(null);
  for (let i = n - 1; i < v.length; i++) {
    const w = v.slice(i - n + 1, i + 1), m = w.reduce((a, b) => a + b, 0) / n;
    out[i] = Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / n);
  }
  return out;
}


/** Applies fn (an array -> array smoother) to the values after the leading nulls, keeping alignment. */
function afterNulls(v, fn) {
  const first = v.findIndex((x) => x != null);
  if (first < 0) return new Array(v.length).fill(null);
  return [...new Array(first).fill(null), ...fn(v.slice(first))];
}

const highest = (v, n, i) => { let m = -Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.max(m, v[j]); return m; };
const lowest = (v, n, i) => { let m = Infinity; for (let j = Math.max(0, i - n + 1); j <= i; j++) m = Math.min(m, v[j]); return m; };

function trueRange(c) {
  return c.map((x, i) => (i === 0 ? x.high - x.low : Math.max(x.high - x.low, Math.abs(x.high - c[i - 1].close), Math.abs(x.low - c[i - 1].close))));
}
export const atrValues = (c, n) => rmaValues(trueRange(c), n);

function rsiValues(v, n) {
  const g = [null], l = [null];
  for (let i = 1; i < v.length; i++) { const d = v[i] - v[i - 1]; g.push(Math.max(d, 0)); l.push(Math.max(-d, 0)); }
  const ag = rmaValues(g, n), al = rmaValues(l, n);
  return v.map((_, i) => (ag[i] == null ? null : al[i] === 0 ? 100 : 100 - 100 / (1 + ag[i] / al[i])));
}

function supertrend(c, n, mult) {
  const atr = atrValues(c, n), up = [], dn = [];
  const line = new Array(c.length).fill(null), dir = new Array(c.length).fill(1);
  for (let i = 0; i < c.length; i++) {
    if (atr[i] == null) { up.push(null); dn.push(null); continue; }
    const hl2 = (c[i].high + c[i].low) / 2;
    let u = hl2 + mult * atr[i], d = hl2 - mult * atr[i];
    const pu = up[i - 1], pd = dn[i - 1];
    if (pu != null) u = u < pu || c[i - 1].close > pu ? u : pu;
    if (pd != null) d = d > pd || c[i - 1].close < pd ? d : pd;
    up.push(u); dn.push(d);
    const prevDir = dir[i - 1] ?? 1;
    dir[i] = prevDir === 1 ? (c[i].close < d ? -1 : 1) : (c[i].close > u ? 1 : -1);
    line[i] = dir[i] === 1 ? d : u;
  }
  return { line, dir };
}

function psar(c, step = 0.02, max = 0.2) {
  const out = new Array(c.length).fill(null);
  if (c.length < 2) return out;
  let up = c[1].close >= c[0].close, sar = up ? c[0].low : c[0].high, ep = up ? c[0].high : c[0].low, af = step;
  for (let i = 1; i < c.length; i++) {
    sar = sar + af * (ep - sar);
    if (up) {
      sar = Math.min(sar, c[i - 1].low, c[Math.max(0, i - 2)].low);
      if (c[i].low < sar) { up = false; sar = ep; ep = c[i].low; af = step; }
      else if (c[i].high > ep) { ep = c[i].high; af = Math.min(max, af + step); }
    } else {
      sar = Math.max(sar, c[i - 1].high, c[Math.max(0, i - 2)].high);
      if (c[i].high > sar) { up = true; sar = ep; ep = c[i].high; af = step; }
      else if (c[i].low < ep) { ep = c[i].low; af = Math.min(max, af + step); }
    }
    out[i] = sar;
  }
  return out;
}

function adx(c, n) {
  const pdm = [0], ndm = [0];
  for (let i = 1; i < c.length; i++) {
    const upMove = c[i].high - c[i - 1].high, downMove = c[i - 1].low - c[i].low;
    pdm.push(upMove > downMove && upMove > 0 ? upMove : 0);
    ndm.push(downMove > upMove && downMove > 0 ? downMove : 0);
  }
  const tr = rmaValues(trueRange(c), n), sp = rmaValues(pdm, n), sn = rmaValues(ndm, n);
  const pdi = c.map((_, i) => (tr[i] ? (100 * sp[i]) / tr[i] : null));
  const ndi = c.map((_, i) => (tr[i] ? (100 * sn[i]) / tr[i] : null));
  const dx = c.map((_, i) => (pdi[i] == null || pdi[i] + ndi[i] === 0 ? null : (100 * Math.abs(pdi[i] - ndi[i])) / (pdi[i] + ndi[i])));
  return { adx: rmaValues(dx, n), pdi, ndi };
}

// ---------------- registry ----------------
// kind "overlay" draws on the price chart; kind "pane" gets its own pane below.
// compute() returns { lines: [{ data, color, width?, style?, type?: "line"|"histogram"|"dots" }], levels?: [numbers] }

const C = { yellow: "#f7c948", orange: "#ff9f43", blue: "#4dabf7", violet: "#b197fc", pink: "#e599f7", teal: "#20c997", red: "#ff6b6b", green: "#51cf66", gray: "#868e96", indigo: "#7c8cff" };

export const INDICATORS = {
  vol: { label: "Volume", kind: "volume", group: "Volume", params: {} },
  sma: { label: "Moving Average (SMA)", kind: "overlay", group: "Trend", params: { period: 50 }, compute: (c, p) => ({ lines: [{ data: pts(c, smaValues(closes(c), p.period)), color: C.orange }] }) },
  ema: { label: "Exponential MA (EMA)", kind: "overlay", group: "Trend", params: { period: 20 }, compute: (c, p) => ({ lines: [{ data: pts(c, emaValues(closes(c), p.period)), color: C.blue }] }) },
  wma: { label: "Weighted MA (WMA)", kind: "overlay", group: "Trend", params: { period: 20 }, compute: (c, p) => ({ lines: [{ data: pts(c, wmaValues(closes(c), p.period)), color: C.pink }] }) },
  hma: {
    label: "Hull MA", kind: "overlay", group: "Trend", params: { period: 21 },
    compute: (c, p) => {
      const v = closes(c), h = Math.round(p.period / 2), sq = Math.round(Math.sqrt(p.period));
      const a = wmaValues(v, h), b = wmaValues(v, p.period);
      const diff = v.map((_, i) => (a[i] == null || b[i] == null ? null : 2 * a[i] - b[i]));
      return { lines: [{ data: pts(c, afterNulls(diff, (x) => wmaValues(x, sq))), color: C.teal, width: 2 }] };
    },
  },
  vwap: {
    label: "VWAP (intraday, session)", kind: "overlay", group: "Volume", params: {},
    compute: (c) => {
      const out = [];
      let pv = 0, vol = 0, day = null;
      for (const x of c) {
        const d = Math.floor(x.time / 86400);
        if (d !== day) { pv = 0; vol = 0; day = d; }
        pv += ((x.high + x.low + x.close) / 3) * (x.volume || 0);
        vol += x.volume || 0;
        out.push(vol > 0 ? pv / vol : null);
      }
      return { lines: [{ data: pts(c, out), color: C.teal, width: 2 }] };
    },
  },
  bb: {
    label: "Bollinger Bands", kind: "overlay", group: "Volatility", params: { period: 20, mult: 2 },
    compute: (c, p) => {
      const m = smaValues(closes(c), p.period), sd = stdevValues(closes(c), p.period);
      return { lines: [
        { data: pts(c, m.map((x, i) => (x == null ? null : x + p.mult * sd[i]))), color: C.indigo, width: 1 },
        { data: pts(c, m), color: C.indigo, width: 1, style: 2 },
        { data: pts(c, m.map((x, i) => (x == null ? null : x - p.mult * sd[i]))), color: C.indigo, width: 1 },
      ] };
    },
  },
  keltner: {
    label: "Keltner Channels", kind: "overlay", group: "Volatility", params: { period: 20, mult: 2 },
    compute: (c, p) => {
      const m = emaValues(closes(c), p.period), a = atrValues(c, p.period);
      return { lines: [
        { data: pts(c, m.map((x, i) => (x == null || a[i] == null ? null : x + p.mult * a[i]))), color: C.teal, width: 1 },
        { data: pts(c, m), color: C.teal, width: 1, style: 2 },
        { data: pts(c, m.map((x, i) => (x == null || a[i] == null ? null : x - p.mult * a[i]))), color: C.teal, width: 1 },
      ] };
    },
  },
  donchian: {
    label: "Donchian Channels", kind: "overlay", group: "Volatility", params: { period: 20 },
    compute: (c, p) => {
      const hi = c.map((_, i) => (i < p.period - 1 ? null : highest(c.map((x) => x.high), p.period, i)));
      const lo = c.map((_, i) => (i < p.period - 1 ? null : lowest(c.map((x) => x.low), p.period, i)));
      return { lines: [
        { data: pts(c, hi), color: C.blue, width: 1 },
        { data: pts(c, hi.map((h, i) => (h == null ? null : (h + lo[i]) / 2))), color: C.blue, width: 1, style: 2 },
        { data: pts(c, lo), color: C.blue, width: 1 },
      ] };
    },
  },
  supertrend: {
    label: "Supertrend", kind: "overlay", group: "Trend", params: { period: 10, mult: 3 },
    compute: (c, p) => {
      const { line, dir } = supertrend(c, p.period, p.mult);
      return { lines: [
        { data: pts(c, line.map((v, i) => (dir[i] === 1 ? v : null))), color: C.green, width: 2, type: "dots" },
        { data: pts(c, line.map((v, i) => (dir[i] === -1 ? v : null))), color: C.red, width: 2, type: "dots" },
      ] };
    },
  },
  psar: { label: "Parabolic SAR", kind: "overlay", group: "Trend", params: {}, compute: (c) => ({ lines: [{ data: pts(c, psar(c)), color: C.yellow, type: "dots" }] }) },
  ichimoku: {
    label: "Ichimoku Cloud (lines)", kind: "overlay", group: "Trend", params: { conv: 9, base: 26, span: 52 },
    compute: (c, p) => {
      const hi = c.map((x) => x.high), lo = c.map((x) => x.low);
      const mid = (n) => c.map((_, i) => (i < n - 1 ? null : (highest(hi, n, i) + lowest(lo, n, i)) / 2));
      const conv = mid(p.conv), base = mid(p.base), spanB = mid(p.span);
      const spanA = conv.map((v, i) => (v == null || base[i] == null ? null : (v + base[i]) / 2));
      return { lines: [
        { data: pts(c, conv), color: C.blue, width: 1 },
        { data: pts(c, base), color: C.red, width: 1 },
        { data: pts(c, spanA), color: C.green, width: 1, style: 2 },
        { data: pts(c, spanB), color: C.orange, width: 1, style: 2 },
      ] };
    },
  },
  rsi: { label: "RSI", kind: "pane", group: "Momentum", params: { period: 14 }, compute: (c, p) => ({ lines: [{ data: pts(c, rsiValues(closes(c), p.period)), color: C.violet }], levels: [70, 30] }) },
  macd: {
    label: "MACD", kind: "pane", group: "Momentum", params: { fast: 12, slow: 26, signal: 9 },
    compute: (c, p) => {
      const f = emaValues(closes(c), p.fast), s = emaValues(closes(c), p.slow);
      const line = c.map((_, i) => (f[i] == null || s[i] == null ? null : f[i] - s[i]));
      const sig = emaValues(line, p.signal);
      const hist = line.map((v, i) => (v == null || sig[i] == null ? null : v - sig[i]));
      return { lines: [
        { data: pts(c, hist).map((h) => ({ ...h, color: h.value >= 0 ? "rgba(34,171,148,.6)" : "rgba(242,54,69,.6)" })), type: "histogram" },
        { data: pts(c, line), color: "#2962ff" },
        { data: pts(c, sig), color: "#ff6d00" },
      ], levels: [0] };
    },
  },
  stoch: {
    label: "Stochastic", kind: "pane", group: "Momentum", params: { k: 14, smooth: 3, d: 3 },
    compute: (c, p) => {
      const hi = c.map((x) => x.high), lo = c.map((x) => x.low);
      const raw = c.map((x, i) => { if (i < p.k - 1) return null; const H = highest(hi, p.k, i), L = lowest(lo, p.k, i); return H === L ? 50 : (100 * (x.close - L)) / (H - L); });
      const k = afterNulls(raw, (x) => smaValues(x, p.smooth));
      const d = afterNulls(k, (x) => smaValues(x, p.d));
      return { lines: [{ data: pts(c, k), color: "#2962ff" }, { data: pts(c, d), color: "#ff6d00" }], levels: [80, 20] };
    },
  },
  stochrsi: {
    label: "Stochastic RSI", kind: "pane", group: "Momentum", params: { rsi: 14, stoch: 14, k: 3, d: 3 },
    compute: (c, p) => {
      const r = rsiValues(closes(c), p.rsi);
      const raw = r.map((v, i) => {
        if (v == null || i < p.rsi + p.stoch - 1) return null;
        const w = r.slice(i - p.stoch + 1, i + 1);
        const H = Math.max(...w), L = Math.min(...w);
        return H === L ? 50 : (100 * (v - L)) / (H - L);
      });
      const k = afterNulls(raw, (x) => smaValues(x, p.k));
      const d = afterNulls(k, (x) => smaValues(x, p.d));
      return { lines: [{ data: pts(c, k), color: "#2962ff" }, { data: pts(c, d), color: "#ff6d00" }], levels: [80, 20] };
    },
  },
  cci: {
    label: "CCI", kind: "pane", group: "Momentum", params: { period: 20 },
    compute: (c, p) => {
      const tp = c.map((x) => (x.high + x.low + x.close) / 3), m = smaValues(tp, p.period);
      const out = tp.map((v, i) => {
        if (m[i] == null) return null;
        let md = 0;
        for (let j = i - p.period + 1; j <= i; j++) md += Math.abs(tp[j] - m[i]);
        md /= p.period;
        return md === 0 ? 0 : (v - m[i]) / (0.015 * md);
      });
      return { lines: [{ data: pts(c, out), color: C.teal }], levels: [100, -100] };
    },
  },
  willr: {
    label: "Williams %R", kind: "pane", group: "Momentum", params: { period: 14 },
    compute: (c, p) => {
      const hi = c.map((x) => x.high), lo = c.map((x) => x.low);
      const out = c.map((x, i) => { if (i < p.period - 1) return null; const H = highest(hi, p.period, i), L = lowest(lo, p.period, i); return H === L ? -50 : (-100 * (H - x.close)) / (H - L); });
      return { lines: [{ data: pts(c, out), color: C.violet }], levels: [-20, -80] };
    },
  },
  roc: { label: "Rate of Change", kind: "pane", group: "Momentum", params: { period: 12 }, compute: (c, p) => ({ lines: [{ data: pts(c, c.map((x, i) => (i < p.period ? null : (100 * (x.close - c[i - p.period].close)) / c[i - p.period].close))), color: C.blue }], levels: [0] }) },
  atr: { label: "ATR", kind: "pane", group: "Volatility", params: { period: 14 }, compute: (c, p) => ({ lines: [{ data: pts(c, atrValues(c, p.period)), color: C.red }] }) },
  adx: {
    label: "ADX / DMI", kind: "pane", group: "Trend", params: { period: 14 },
    compute: (c, p) => {
      const r = adx(c, p.period);
      return { lines: [{ data: pts(c, r.adx), color: C.yellow, width: 2 }, { data: pts(c, r.pdi), color: C.green }, { data: pts(c, r.ndi), color: C.red }], levels: [25] };
    },
  },
  obv: {
    label: "On-Balance Volume", kind: "pane", group: "Volume", params: {},
    compute: (c) => {
      let v = 0;
      const out = c.map((x, i) => { if (i > 0) v += x.close > c[i - 1].close ? x.volume : x.close < c[i - 1].close ? -x.volume : 0; return v; });
      return { lines: [{ data: pts(c, out), color: C.blue }] };
    },
  },
  mfi: {
    label: "Money Flow Index", kind: "pane", group: "Volume", params: { period: 14 },
    compute: (c, p) => {
      const tp = c.map((x) => (x.high + x.low + x.close) / 3);
      const out = c.map((_, i) => {
        if (i < p.period) return null;
        let pos = 0, neg = 0;
        for (let j = i - p.period + 1; j <= i; j++) {
          const flow = tp[j] * (c[j].volume || 0);
          if (tp[j] > tp[j - 1]) pos += flow; else if (tp[j] < tp[j - 1]) neg += flow;
        }
        return neg === 0 ? 100 : 100 - 100 / (1 + pos / neg);
      });
      return { lines: [{ data: pts(c, out), color: C.pink }], levels: [80, 20] };
    },
  },
};

export const paramLabel = (k) => ({ period: "Length", mult: "Multiplier", fast: "Fast", slow: "Slow", signal: "Signal", k: "%K", d: "%D", smooth: "Smooth", rsi: "RSI length", stoch: "Stoch length", conv: "Conversion", base: "Base", span: "Span B" })[k] || k;
export const shortLabel = (id, params) => {
  const p = Object.values(params || {});
  const name = { vol: "Volume", sma: "SMA", ema: "EMA", wma: "WMA", hma: "HMA", bb: "BB", keltner: "KC", donchian: "DC", supertrend: "ST", psar: "SAR", ichimoku: "Ichimoku", rsi: "RSI", macd: "MACD", stoch: "Stoch", stochrsi: "StochRSI", cci: "CCI", willr: "%R", roc: "ROC", atr: "ATR", adx: "ADX", obv: "OBV", mfi: "MFI", vwap: "VWAP" }[id] || id;
  return p.length ? `${name} ${p.join(" ")}` : name;
};
