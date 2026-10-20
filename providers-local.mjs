// Local history files: chart and replay markets from CSV files you downloaded (e.g. 1-minute forex, gold, indices).
// Put the files (.csv, or .zip downloads holding .csv files) in data/history/<SYMBOL>/ (any number; overlaps are fine) — the folder name is the symbol.
// Understood formats:
//   dukascopy-node CSV   timestamp,open,high,low,close[,volume]   (epoch ms, UTC)
//   Dukascopy website    Gmt time,Open,High,Low,Close,Volume       (dd.mm.yyyy HH:MM:SS.mmm, GMT or "GMT+0200")
//   HistData ASCII M1    20240102 170000;1.1043;1.1044;1.1043;1.1043;0            (EST all year)
//   MetaTrader CSV       2024.01.02,17:00,1.1043,1.1044,1.1043,1.1043,0          (EST if the file is HistData's DAT_*, else UTC)
//   generic CSV          time,open,high,low,close[,volume] with epoch s/ms or ISO dates (UTC unless an offset is given)
// Bigger timeframes are built from the finest bars in the files; 1m/5m/15m/30m/1H page in batches like Alpaca.
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import { ProviderError, marketOf } from "./providers.mjs";

export const HISTORY_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "data", "history");
const DAY = 86400;
const EST = 5 * 3600; // HistData: US Eastern Standard Time, no daylight saving
const SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600 };
const SPAN = { "1m": 7, "5m": 30, "15m": 120, "30m": 240, "60m": 365 }; // days in the first load (daily and up: everything)
const BATCH = { "1m": 10, "5m": 40, "15m": 120, "30m": 240, "60m": 365 }; // days per history() batch
const NAME_RE = /^[A-Z0-9][A-Z0-9._&=^-]{0,29}$/i;

// ---------------- which symbols have files ----------------

let listing = { at: 0, names: new Map() }; // SYMBOL -> folder name
function folders() {
  if (Date.now() - listing.at < 5000) return listing.names;
  const names = new Map();
  try {
    for (const d of fs.readdirSync(HISTORY_DIR, { withFileTypes: true })) if (d.isDirectory() && NAME_RE.test(d.name)) names.set(d.name.toUpperCase(), d.name);
  } catch { /* no data/history folder yet */ }
  listing = { at: Date.now(), names };
  return names;
}
export const localSymbols = () => [...folders().keys()];

// ---------------- parsing ----------------

const clean = (s) => s.trim().replace(/^"|"$/g, "").replace(/^<|>$/g, "").trim().toLowerCase();
const utc = (Y, M, D, h = 0, m = 0, s = 0) => Date.UTC(+Y, +M - 1, +D, +h, +m, +s) / 1000;

/** Picks the column layout from the header (or the first row when there is none). */
function columns(first, delim) {
  const f = first.split(delim).map(clean);
  if (!/^[a-z]/.test(f[0])) {
    // No header: "date,time,o,h,l,c,v" (MetaTrader) or "time,o,h,l,c,v".
    return /^\d{1,2}:\d{2}/.test(f[1] || "") ? { header: false, time: 0, time2: 1, o: 2, h: 3, l: 4, c: 5, v: 6 } : { header: false, time: 0, o: 1, h: 2, l: 3, c: 4, v: 5 };
  }
  const at = (...names) => f.findIndex((x) => names.includes(x));
  const date = at("date", "day"), time = at("time");
  const stamp = at("timestamp", "datetime", "date time", "date_time", "gmt time", "local time", "utc", "time (utc)", "open time");
  const cols = {
    header: true,
    o: at("open", "o"), h: at("high", "h"), l: at("low", "l"), c: at("close", "c"),
    v: at("volume", "vol", "tickvol", "tick volume", "tick_volume", "v"),
    time: stamp >= 0 ? stamp : date >= 0 ? date : time,
    time2: stamp < 0 && date >= 0 && time >= 0 ? time : undefined,
  };
  if ([cols.time, cols.o, cols.h, cols.l, cols.c].some((i) => i < 0)) throw new ProviderError(`Unrecognized header: "${first.slice(0, 80)}"`, 422);
  return cols;
}

/** Returns row → unix seconds for the date format found in `sample`. */
function timeReader(sample, cols, fileName) {
  const a = clean(sample[cols.time] || ""), b = cols.time2 != null ? clean(sample[cols.time2] || "") : null;
  const histdata = /^dat_/i.test(fileName);
  let m;
  if (/^\d{8} \d{6}$/.test(a)) {
    return (r) => { const s = r[cols.time].trim(); return utc(s.slice(0, 4), s.slice(4, 6), s.slice(6, 8), s.slice(9, 11), s.slice(11, 13), s.slice(13, 15)) + EST; };
  }
  if (b != null && /^\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}$/.test(a) && /^\d{1,2}:\d{2}/.test(b)) {
    const off = histdata ? EST : 0;
    return (r) => { const [Y, M, D] = r[cols.time].trim().split(/[.\-/]/); const [h, mi, s] = r[cols.time2].trim().split(":"); return utc(Y, M, D, h, mi, s || 0) + off; };
  }
  if (/^\d{2}\.\d{2}\.\d{4} \d{2}:\d{2}/.test(a)) {
    // Dukascopy: 01.01.2024 00:00:00.000 [GMT+0200]
    return (r) => {
      const s = r[cols.time].trim();
      const t = utc(s.slice(6, 10), s.slice(3, 5), s.slice(0, 2), s.slice(11, 13), s.slice(14, 16), s.slice(17, 19) || 0);
      const z = /GMT([+-])(\d{2}):?(\d{2})/.exec(s);
      return z ? t - (z[1] === "-" ? -1 : 1) * (+z[2] * 3600 + +z[3] * 60) : t;
    };
  }
  if (/^\d{9,13}(\.\d+)?$/.test(a)) return (r) => { const n = +r[cols.time]; return n > 1e11 ? Math.floor(n / 1000) : Math.floor(n); };
  if ((m = /^\d{4}[.\-]\d{2}[.\-]\d{2}/.exec(a))) {
    const off = histdata ? EST : 0;
    return (r) => {
      let s = r[cols.time].trim().replace(/^"|"$/g, "").replace(/^(\d{4})\.(\d{2})\.(\d{2})/, "$1-$2-$3").replace(" ", "T");
      if (cols.time2 != null) s += "T" + r[cols.time2].trim();
      const zoned = /[zZ]$|[+-]\d\d:?\d\d$/.test(s);
      if (s.length === 10) s += "T00:00:00";
      return Math.floor(Date.parse(zoned ? s : s + "Z") / 1000) + (zoned ? 0 : off);
    };
  }
  throw new ProviderError(`Unrecognized date "${a}" in ${fileName}`, 422);
}

/** Appends the bars of one file to `out` (column arrays). */
function parseFile(text, fileName, out) {
  let pos = 0;
  while (pos < text.length && /\s/.test(text[pos])) pos++;
  const firstEnd = text.indexOf("\n", pos);
  const first = text.slice(pos, firstEnd < 0 ? undefined : firstEnd).replace(/\r$/, "");
  if (!first) return;
  const delim = first.includes(";") ? ";" : first.includes("\t") ? "\t" : ",";
  const cols = columns(first, delim);
  if (cols.header) pos = firstEnd < 0 ? text.length : firstEnd + 1;
  let readTime = null;
  while (pos < text.length) {
    let end = text.indexOf("\n", pos);
    if (end < 0) end = text.length;
    const line = text.slice(pos, end);
    pos = end + 1;
    if (line.length < 5) continue;
    const r = line.split(delim);
    readTime ??= timeReader(r, cols, fileName);
    const t = readTime(r), o = +r[cols.o], h = +r[cols.h], l = +r[cols.l], c = +r[cols.c];
    if (!Number.isFinite(t) || ![o, h, l, c].every(Number.isFinite)) continue;
    out.t.push(t); out.o.push(o); out.h.push(h); out.l.push(l); out.c.push(c);
    out.v.push(cols.v >= 0 && cols.v != null ? +r[cols.v] || 0 : 0);
  }
}

/** The .csv entries of a .zip file (stored or deflated), read with the central directory. */
function csvInZip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new ProviderError("Not a valid .zip file", 422);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new ProviderError("Damaged .zip file", 422);
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!/\.csv$/i.test(name)) continue; // HistData zips also hold a .txt gap report
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method !== 0 && method !== 8) throw new ProviderError(`Unsupported compression in ${name}`, 422);
    out.push({ name: path.basename(name), text: (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8") });
  }
  if (!out.length) throw new ProviderError("No .csv file inside the .zip", 422);
  return out;
}

// ---------------- loading (cached in memory as typed arrays) ----------------

const loaded = new Map(); // SYMBOL -> Promise<series>, keyed by the files' size/mtime signature
async function series(symbol) {
  const folder = folders().get(symbol.toUpperCase());
  if (!folder) throw new ProviderError("No local history files for this symbol", 404);
  const dir = path.join(HISTORY_DIR, folder);
  const files = (await fs.promises.readdir(dir)).filter((f) => /\.(csv|zip)$/i.test(f)).sort();
  if (!files.length) throw new ProviderError(`No .csv or .zip files in data/history/${folder}`, 404);
  const stats = await Promise.all(files.map((f) => fs.promises.stat(path.join(dir, f))));
  const sig = files.map((f, i) => `${f}:${stats[i].size}:${stats[i].mtimeMs}`).join("|");
  const hit = loaded.get(folder);
  if (hit?.sig === sig) return hit.promise;
  const promise = (async () => {
    const raw = { t: [], o: [], h: [], l: [], c: [], v: [] };
    for (const f of files) {
      try {
        const buf = await fs.promises.readFile(path.join(dir, f));
        if (/\.zip$/i.test(f)) for (const e of csvInZip(buf)) parseFile(e.text, e.name, raw); // e.g. HistData downloads, used as-is
        else parseFile(buf.toString("utf8"), f, raw);
      } catch (err) { throw new ProviderError(`${folder}/${f}: ${err.message}`, err.status || 422); }
    }
    if (!raw.t.length) throw new ProviderError(`No bars found in data/history/${folder}`, 404);
    // Sort by time (files are usually already in order); where files overlap keep one bar per timestamp (the later file wins).
    let sorted = true;
    for (let i = 1; i < raw.t.length && sorted; i++) sorted = raw.t[i] > raw.t[i - 1];
    const idx = sorted ? Array.from(raw.t.keys()) : Array.from(raw.t.keys()).sort((a, b) => raw.t[a] - raw.t[b] || a - b);
    const keep = [];
    for (const i of idx) { if (keep.length && raw.t[keep[keep.length - 1]] === raw.t[i]) keep[keep.length - 1] = i; else keep.push(i); }
    const col = (k) => Float64Array.from(keep, (i) => raw[k][i]);
    const s = { n: keep.length, t: col("t"), o: col("o"), h: col("h"), l: col("l"), c: col("c"), v: col("v") };
    const diffs = [];
    for (let i = 1; i < Math.min(s.n, 2000); i++) diffs.push(s.t[i] - s.t[i - 1]);
    diffs.sort((a, b) => a - b);
    s.step = diffs[Math.floor(diffs.length / 2)] || 60; // finest bar size in the files
    return s;
  })();
  loaded.set(folder, { sig, promise });
  promise.catch(() => { if (loaded.get(folder)?.promise === promise) loaded.delete(folder); });
  return promise;
}

/** First index with t >= x. */
function lowerBound(t, x) {
  let lo = 0, hi = t.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (t[mid] < x) lo = mid + 1; else hi = mid; }
  return lo;
}

// Sunday-evening bars (when FX and index CFDs reopen) count towards Monday, so there is no stub Sunday candle.
const tradingDay = (t) => { let d = Math.floor(t / DAY); if ((d + 4) % 7 === 0) d++; return d; };
function bucketOf(interval) {
  if (SECONDS[interval]) { const S = SECONDS[interval]; return (t) => t - (t % S); }
  if (interval === "1d") return (t) => tradingDay(t) * DAY;
  if (interval === "1wk") return (t) => { const d = tradingDay(t); return (d - ((d + 3) % 7)) * DAY; };
  return (t) => { const d = new Date(tradingDay(t) * DAY * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; };
}

/** Bars [i0, i1) merged into `interval` candles. */
function aggregate(s, i0, i1, interval) {
  const key = bucketOf(interval);
  const out = [];
  let cur = null;
  for (let i = i0; i < i1; i++) {
    const k = key(s.t[i]);
    if (cur && cur.time === k) {
      if (s.h[i] > cur.high) cur.high = s.h[i];
      if (s.l[i] < cur.low) cur.low = s.l[i];
      cur.close = s.c[i];
      cur.volume += s.v[i];
    } else {
      cur = { time: k, open: s.o[i], high: s.h[i], low: s.l[i], close: s.c[i], volume: s.v[i] };
      out.push(cur);
    }
  }
  return out;
}

async function seriesFor(symbol, interval) {
  const s = await series(symbol);
  if (SECONDS[interval] && (SECONDS[interval] < s.step || SECONDS[interval] % s.step)) {
    throw new ProviderError(`The local files have ${s.step / 60}-minute bars; ${interval} can't be built from them`, 400);
  }
  return s;
}
const alignDown = (t, S) => Math.floor(t / S) * S;
const alignUp = (t, S) => Math.ceil(t / S) * S;
const CURRENCY = /(USD|EUR|GBP|JPY|CHF|AUD|CAD|NZD|INR)$/;

export const local = {
  id: "local", name: "Local files", builtIn: true, live: false,
  markets: ["india", "us", "global", "crypto", "forex", "futures"],
  note: "Your own downloaded history (e.g. years of 1-minute forex, gold or index bars) for charts and replay. Put CSV files in data/history/<SYMBOL>/ — for example data/history/EURUSD/ — and search for that symbol. Dukascopy, HistData, MetaTrader and plain time,open,high,low,close CSVs work.",
  supports: (symbol) => folders().has(symbol.toUpperCase()),
  async candles(symbol, interval) {
    const s = await seriesFor(symbol, interval);
    if (!SECONDS[interval]) return aggregate(s, 0, s.n, interval);
    const start = alignDown(s.t[s.n - 1] - SPAN[interval] * DAY, SECONDS[interval]); // the files' last bar, not today
    return aggregate(s, lowerBound(s.t, start), s.n, interval);
  },
  /** The batch before `before` / after `after` (unix s), aligned to whole candles. `done` = no more files that way. */
  async history(symbol, interval, cfg, { before, after }) {
    const s = await seriesFor(symbol, interval);
    const S = SECONDS[interval];
    if (!S) return { candles: [], done: true }; // daily and up are loaded in full
    if (before != null) {
      const i1 = lowerBound(s.t, alignUp(before, S));
      if (i1 === 0) return { candles: [], done: true };
      const i0 = lowerBound(s.t, alignDown(s.t[i1 - 1], S) - BATCH[interval] * DAY); // anchored on the last bar, so gaps don't give empty batches
      return { candles: aggregate(s, i0, i1, interval), done: i0 === 0 };
    }
    const i0 = lowerBound(s.t, alignDown(after, S) + S);
    if (i0 >= s.n) return { candles: [], done: true };
    const i1 = lowerBound(s.t, alignDown(s.t[i0], S) + BATCH[interval] * DAY);
    return { candles: aggregate(s, i0, i1, interval), done: i1 >= s.n };
  },
  /** Chart/watchlist details from the files (no live quote exists for them). */
  async quote(symbol) {
    const s = await series(symbol);
    const days = aggregate(s, lowerBound(s.t, s.t[s.n - 1] - 10 * DAY), s.n, "1d");
    const last = days[days.length - 1], prev = days[days.length - 2];
    const folder = folders().get(symbol.toUpperCase());
    return {
      symbol, name: `${folder} (local files)`, exchange: "Local files", currency: CURRENCY.exec(folder.toUpperCase())?.[1] || "",
      type: "LOCAL", gmtoffset: 0, timezone: "UTC", price: s.c[s.n - 1], prevClose: prev?.close ?? last.open,
      dayHigh: last.high, dayLow: last.low, volume: last.volume, marketTime: s.t[s.n - 1],
      market: marketOf(symbol), marketOpen: false, spark: days.slice(-5).map((d) => d.close),
    };
  },
};
