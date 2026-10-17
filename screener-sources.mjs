// Screener data that doesn't depend on Yahoo's (now session-locked) screener endpoint:
// - India: NSE's official index constituent lists (NIFTY 50 … Total Market)
// - United States: Nasdaq's public stock screener (all NASDAQ / NYSE / NYSE American stocks)
// Each stock is then enriched from a year of Yahoo daily candles (no login needed), which gives
// price, change, volume, relative volume, 52-week range, moving-average distance and returns.
import { yahoo } from "./providers.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";
const DAY = 86400;

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Runs fn over items with at most `limit` in flight; failed items resolve to null. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      try { out[i] = await fn(items[i], i); } catch { out[i] = null; }
    }
  }));
  return out;
}

function parseCsv(text) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const cells = [];
    let cur = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { if (quoted && line[i + 1] === '"') { cur += '"'; i++; } else quoted = !quoted; }
      else if (ch === "," && !quoted) { cells.push(cur.trim()); cur = ""; }
      else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

// ---------------- per-stock metrics from daily candles ----------------

const dayKey = (unix, off) => new Date((unix + off) * 1000).toISOString().slice(0, 10);
const sma = (values, n) => (values.length >= n ? values.slice(-n).reduce((a, b) => a + b, 0) / n : null);
const pct = (now, base) => (base ? ((now - base) / base) * 100 : null);

/** One stock's screener row computed from Yahoo's 1-year daily history (cached a few minutes). */
export function stockMetrics(symbol) {
  return cached(`m:${symbol}`, 4 * 60_000, async () => {
    const { meta, candles: c } = await yahoo.raw(symbol, "1d", "1y");
    if (!c.length) return null;
    const off = meta.gmtoffset ?? 0;
    const last = c[c.length - 1];
    const lastIsToday = meta.marketTime && dayKey(last.time, off) === dayKey(meta.marketTime, off);
    const done = lastIsToday ? c.slice(0, -1) : c; // completed sessions
    const prevClose = done[done.length - 1]?.close ?? meta.prevClose;
    const price = meta.price ?? last.close;
    const closes = c.map((x) => x.close);
    const vols = done.slice(-63).map((x) => x.volume || 0);
    const avgVol3m = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : null;
    const volume = meta.volume ?? (lastIsToday ? last.volume : 0);
    const high52 = meta.high52 ?? Math.max(...c.map((x) => x.high));
    const low52 = meta.low52 ?? Math.min(...c.map((x) => x.low));
    const at = (secsAgo) => { const t = last.time - secsAgo; for (let i = c.length - 1; i >= 0; i--) if (c[i].time <= t) return c[i].close; return c[0].close; };
    const yStart = Date.UTC(new Date(last.time * 1000).getUTCFullYear(), 0, 1) / 1000;
    const beforeYear = c.filter((x) => x.time < yStart).pop();
    const ma50 = sma(closes, 50), ma200 = sma(closes, 200);
    return {
      symbol, currency: meta.currency, price,
      change: prevClose != null ? price - prevClose : null, changePct: pct(price, prevClose), prevClose,
      open: lastIsToday ? last.open : null, high: meta.dayHigh, low: meta.dayLow,
      volume, avgVol3m, relVol: avgVol3m ? volume / avgVol3m : null, turnover: volume ? volume * price : null,
      high52, low52, fromHigh52: pct(price, high52), fromLow52: pct(price, low52), chg52w: pct(price, c[0].close),
      vs50: ma50 ? pct(price, ma50) : null, vs200: ma200 ? pct(price, ma200) : null,
      perf: { w1: pct(price, at(7 * DAY)), m1: pct(price, at(30 * DAY)), m3: pct(price, at(91 * DAY)), m6: pct(price, at(182 * DAY)), ytd: pct(price, beforeYear?.close ?? c[0].close), y1: pct(price, c[0].close) },
      marketState: meta.marketOpen ? "REGULAR" : "CLOSED",
    };
  });
}

// ---------------- India: NSE index constituents ----------------

export const INDIA_UNIVERSES = {
  nifty50: ["NIFTY 50", "ind_nifty50list"],
  nifty100: ["NIFTY 100", "ind_nifty100list"],
  nifty200: ["NIFTY 200", "ind_nifty200list"],
  nifty500: ["NIFTY 500", "ind_nifty500list"],
  midcap150: ["NIFTY Midcap 150", "ind_niftymidcap150list"],
  smallcap250: ["NIFTY Smallcap 250", "ind_niftysmallcap250list"],
  microcap250: ["NIFTY Microcap 250", "ind_niftymicrocap250_list"],
  total: ["NIFTY Total Market (750)", "ind_niftytotalmarket_list"],
};

async function indiaList(universe) {
  const [, file] = INDIA_UNIVERSES[universe] || INDIA_UNIVERSES.nifty500;
  return cached(`nse:${file}`, 12 * 3600_000, async () => {
    const res = await fetch(`https://nsearchives.nseindia.com/content/indices/${file}.csv`, { headers: { "User-Agent": UA } });
    if (!res.ok) throw Object.assign(new Error(`NSE index list unavailable (HTTP ${res.status})`), { status: 502 });
    const [head, ...rows] = parseCsv(await res.text());
    const col = (name) => head.findIndex((h) => h.toLowerCase().startsWith(name));
    const iName = col("company"), iInd = col("industry"), iSym = col("symbol");
    return rows.filter((r) => r[iSym]).map((r) => ({ symbol: `${r[iSym]}.NS`, name: r[iName], sector: r[iInd] || null, exchange: "NSE" }));
  });
}

export async function screenIndia({ universe = "nifty500" }) {
  const list = await indiaList(universe);
  const metrics = await mapLimit(list, 16, (s) => stockMetrics(s.symbol));
  const rows = list.map((s, i) => (metrics[i] ? { ...metrics[i], ...s, mcap: null, pe: null, divYield: null } : null)).filter(Boolean);
  return {
    total: list.length, returned: rows.length, currency: "INR", rows,
    universe: INDIA_UNIVERSES[universe]?.[0] || "NIFTY 500",
    sectors: [...new Set(rows.map((r) => r.sector).filter(Boolean))].sort(),
    note: rows.length < list.length ? `${list.length - rows.length} stocks had no price data` : null,
  };
}

// ---------------- United States: Nasdaq screener ----------------

export const US_EXCHANGES = { nasdaq: "NASDAQ", nyse: "NYSE", amex: "NYSE American" };
const num = (s) => { const n = parseFloat(String(s ?? "").replace(/[$,%]/g, "")); return Number.isFinite(n) ? n : null; };

async function nasdaqAll() {
  return cached("nasdaq:all", 5 * 60_000, async () => {
    const lists = await Promise.all(Object.keys(US_EXCHANGES).map(async (ex) => {
      const res = await fetch(`https://api.nasdaq.com/api/screener/stocks?tableonly=true&download=true&exchange=${ex}`, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw Object.assign(new Error(`Nasdaq screener unavailable (HTTP ${res.status})`), { status: 502 });
      const body = await res.json();
      return (body?.data?.rows || []).map((r) => ({ ...r, _ex: ex }));
    }));
    return lists.flat()
      .filter((r) => r.symbol && !/[\^~]/.test(r.symbol)) // skip preferreds/warrants notation
      .map((r) => ({
        symbol: r.symbol.trim().replace("/", "-"), name: r.name?.replace(/ (Common Stock|Ordinary Shares|Class [A-Z] Common Stock)$/i, "") || r.symbol,
        exchange: US_EXCHANGES[r._ex], exKey: r._ex, currency: "USD",
        price: num(r.lastsale), change: num(r.netchange), changePct: num(r.pctchange),
        volume: num(r.volume), mcap: num(r.marketCap) || null, sector: r.sector || null, industry: r.industry || null,
      }));
  });
}

export async function screenUS({ exchanges = [], filters = {}, limit = 500 }) {
  let rows = await nasdaqAll();
  const total = rows.length;
  const exSet = new Set(exchanges.length ? exchanges : Object.keys(US_EXCHANGES));
  const f = filters;
  const inRange = (v, lo, hi) => v != null && (lo == null || v >= +lo) && (hi == null || v <= +hi);
  rows = rows.filter((r) => exSet.has(r.exKey)
    && (f.priceMin == null && f.priceMax == null || inRange(r.price, f.priceMin, f.priceMax))
    && (f.mcapMin == null && f.mcapMax == null || inRange(r.mcap, f.mcapMin, f.mcapMax))
    && (f.volMin == null && f.volMax == null || inRange(r.volume, f.volMin, f.volMax))
    && (f.chgMin == null && f.chgMax == null || inRange(r.changePct, f.chgMin, f.chgMax))
    && (!f.sectors?.length || f.sectors.includes(r.sector)));
  const matched = rows.length;
  rows.sort((a, b) => (b.mcap || 0) - (a.mcap || 0));
  const top = rows.slice(0, Math.min(Math.max(+limit || 500, 50), 1500));
  const metrics = await mapLimit(top, 16, (r) => stockMetrics(r.symbol));
  const out = top.map((r, i) => {
    const m = metrics[i] || {};
    // Nasdaq's price/change/volume are fresher; Yahoo supplies the history-based figures.
    return { ...m, ...r, open: m.open ?? null, relVol: m.avgVol3m && r.volume ? r.volume / m.avgVol3m : m.relVol ?? null,
      turnover: r.volume && r.price ? r.volume * r.price : null, pe: null, divYield: null,
      fromHigh52: m.high52 && r.price ? pct(r.price, m.high52) : m.fromHigh52 ?? null,
      fromLow52: m.low52 && r.price ? pct(r.price, m.low52) : m.fromLow52 ?? null };
  });
  return {
    total, matched, returned: out.length, currency: "USD", rows: out,
    universe: `Top ${out.length.toLocaleString()} of ${matched.toLocaleString()} matching US stocks by market cap`,
    sectors: [...new Set((await nasdaqAll()).map((r) => r.sector).filter(Boolean))].sort(),
  };
}
