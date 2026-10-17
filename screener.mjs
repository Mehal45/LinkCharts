// Stock screener backed by Yahoo Finance's public screener endpoint.
// Yahoo pre-filters a market by exchange/sector/price/volume/market cap; the app then
// filters and sorts precisely on the client (Yahoo ignores some sort fields).
import { yahoo } from "./providers.mjs";
import { screenIndia, screenUS, INDIA_UNIVERSES, US_EXCHANGES } from "./screener-sources.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";

export const SCREENER_MARKETS = {
  // India and the US use dedicated sources (NSE index lists, Nasdaq screener) — see screener-sources.mjs.
  india: { label: "India", region: "IN", exchanges: {}, universes: Object.fromEntries(Object.entries(INDIA_UNIVERSES).map(([k, [label]]) => [k, label])), currency: "INR", source: "NSE index lists + Yahoo prices" },
  us: { label: "United States", region: "US", exchanges: US_EXCHANGES, currency: "USD", source: "Nasdaq screener + Yahoo history" },
  uk: { label: "United Kingdom", region: "GB", exchanges: { LSE: "London" }, currency: "GBP" },
  germany: { label: "Germany", region: "DE", exchanges: { GER: "XETRA", FRA: "Frankfurt" }, currency: "EUR" },
  japan: { label: "Japan", region: "JP", exchanges: { JPX: "Tokyo" }, currency: "JPY" },
  hongkong: { label: "Hong Kong", region: "HK", exchanges: { HKG: "HKEX" }, currency: "HKD" },
  canada: { label: "Canada", region: "CA", exchanges: { TOR: "Toronto", VAN: "TSX Venture" }, currency: "CAD" },
  australia: { label: "Australia", region: "AU", exchanges: { ASX: "ASX" }, currency: "AUD" },
};
export const SECTORS = ["Basic Materials", "Communication Services", "Consumer Cyclical", "Consumer Defensive", "Energy", "Financial Services", "Healthcare", "Industrials", "Real Estate", "Technology", "Utilities"];

// ---------------- Yahoo session (cookie + crumb) ----------------

let session = null; // { cookie, crumb, at }
async function getSession(force = false) {
  if (session && !force && Date.now() - session.at < 30 * 60_000) return session;
  const r1 = await fetch("https://fc.yahoo.com/", { headers: { "User-Agent": UA }, redirect: "manual" });
  const cookie = (r1.headers.getSetCookie?.() || []).map((c) => c.split(";")[0]).join("; ");
  const r2 = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", { headers: { "User-Agent": UA, Cookie: cookie } });
  const crumb = (await r2.text()).trim();
  if (!crumb || crumb.includes("<") || crumb.includes("{") || crumb.length > 40) throw Object.assign(new Error("Couldn't start a Yahoo session for the screener"), { status: 502 });
  session = { cookie, crumb, at: Date.now() };
  return session;
}

async function yahooScreen(region, query, offset, size) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const s = await getSession(attempt > 0);
    const res = await fetch(`https://query2.finance.yahoo.com/v1/finance/screener?crumb=${encodeURIComponent(s.crumb)}&lang=en-US&region=${region}&formatted=false`, {
      method: "POST",
      headers: { "User-Agent": UA, Cookie: s.cookie, "Content-Type": "application/json" },
      body: JSON.stringify({ size, offset, sortField: "intradaymarketcap", sortType: "DESC", quoteType: "EQUITY", query, userId: "", userIdType: "guid" }),
    });
    if (res.status === 401 || res.status === 403) continue; // stale crumb: refresh once
    const body = await res.json();
    const r = body?.finance?.result?.[0];
    if (!r) throw Object.assign(new Error(body?.finance?.error?.description || "Screener request failed"), { status: 502 });
    return r;
  }
  throw Object.assign(new Error("Yahoo rejected the screener session"), { status: 502 });
}

// ---------------- request → Yahoo query ----------------

const num = (v) => (v === "" || v == null || !Number.isFinite(+v) ? null : +v);

function buildQuery(req) {
  const market = SCREENER_MARKETS[req.market] || SCREENER_MARKETS.india;
  const exchanges = (req.exchanges?.length ? req.exchanges : Object.keys(market.exchanges)).filter((e) => market.exchanges[e]);
  const ops = [{ operator: "or", operands: exchanges.map((e) => ({ operator: "eq", operands: ["exchange", e] })) }];
  const range = (field, min, max) => {
    if (min != null && max != null) ops.push({ operator: "btwn", operands: [field, min, max] });
    else if (min != null) ops.push({ operator: "gt", operands: [field, min] });
    else if (max != null) ops.push({ operator: "lt", operands: [field, max] });
  };
  const f = req.filters || {};
  range("intradayprice", num(f.priceMin), num(f.priceMax));
  range("intradaymarketcap", num(f.mcapMin), num(f.mcapMax));
  range("dayvolume", num(f.volMin), num(f.volMax));
  range("percentchange", num(f.chgMin), num(f.chgMax));
  if (f.sectors?.length) ops.push({ operator: "or", operands: f.sectors.filter((s) => SECTORS.includes(s)).map((s) => ({ operator: "eq", operands: ["sector", s] })) });
  return { market, query: { operator: "AND", operands: ops } };
}

const compact = (q) => ({
  symbol: q.symbol, name: q.shortName || q.longName || q.symbol, exchange: q.fullExchangeName || q.exchange, currency: q.currency,
  price: q.regularMarketPrice, change: q.regularMarketChange, changePct: q.regularMarketChangePercent,
  open: q.regularMarketOpen, high: q.regularMarketDayHigh, low: q.regularMarketDayLow, prevClose: q.regularMarketPreviousClose,
  volume: q.regularMarketVolume, avgVol3m: q.averageDailyVolume3Month, avgVol10d: q.averageDailyVolume10Day,
  relVol: q.averageDailyVolume3Month ? q.regularMarketVolume / q.averageDailyVolume3Month : null,
  mcap: q.marketCap, pe: q.trailingPE ?? null, fpe: q.forwardPE ?? null, pb: q.priceToBook ?? null, eps: q.epsTrailingTwelveMonths ?? null,
  divYield: q.dividendYield ?? (q.trailingAnnualDividendYield != null ? q.trailingAnnualDividendYield * 100 : null),
  high52: q.fiftyTwoWeekHigh, low52: q.fiftyTwoWeekLow,
  fromHigh52: q.fiftyTwoWeekHighChangePercent != null ? q.fiftyTwoWeekHighChangePercent * 100 : null,
  fromLow52: q.fiftyTwoWeekLowChangePercent != null ? q.fiftyTwoWeekLowChangePercent * 100 : null,
  chg52w: q.fiftyTwoWeekChangePercent ?? null,
  vs50: q.fiftyDayAverageChangePercent != null ? q.fiftyDayAverageChangePercent * 100 : null,
  vs200: q.twoHundredDayAverageChangePercent != null ? q.twoHundredDayAverageChangePercent * 100 : null,
  rating: q.averageAnalystRating || null, earnings: q.earningsTimestamp || null, marketState: q.marketState,
});

const screenCache = new Map();

/** Runs a screen and returns up to `limit` rows (largest companies first) plus the total match count. */
export async function runScreen(req) {
  const limit = Math.min(Math.max(+req.limit || 500, 50), 1500);
  const key = JSON.stringify({ ...req, limit });
  const hit = screenCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.value;
  let value;
  if (req.market === "india") value = await screenIndia({ universe: req.universe });
  else if (req.market === "us") value = await screenUS({ exchanges: req.exchanges, filters: req.filters, limit });
  else value = await yahooMarketScreen(req, limit);
  screenCache.set(key, { at: Date.now(), value });
  if (screenCache.size > 50) screenCache.delete(screenCache.keys().next().value);
  return value;
}

/** Other markets: Yahoo's screener, which needs a Yahoo session that Yahoo may refuse. */
async function yahooMarketScreen(req, limit) {
  const { market, query } = buildQuery(req);
  let first;
  try { first = await yahooScreen(market.region, query, 0, 250); } catch { first = null; }
  if (!first || !first.total) {
    throw Object.assign(new Error(`Screening ${market.label} relies on Yahoo's screener, which isn't answering right now (Yahoo has started refusing sessions from apps like this). India and United States screening use other sources and still work.`), { status: 503 });
  }
  const pages = [first];
  const want = Math.min(limit, first.total);
  const offsets = [];
  for (let off = 250; off < want; off += 250) offsets.push(off);
  for (let i = 0; i < offsets.length; i += 3) {
    pages.push(...(await Promise.all(offsets.slice(i, i + 3).map((off) => yahooScreen(market.region, query, off, 250)))));
  }
  const seen = new Set();
  const rows = pages.flatMap((p) => p.quotes || []).filter((q) => q.regularMarketPrice != null && !seen.has(q.symbol) && seen.add(q.symbol)).slice(0, limit).map(compact);
  return { total: first.total, returned: rows.length, currency: market.currency, rows, at: Math.floor(Date.now() / 1000), sectors: SECTORS };
}

// ---------------- performance (1W/1M/3M/6M/YTD/1Y) from daily candles ----------------

const perfCache = new Map();
async function perfOne(symbol) {
  const hit = perfCache.get(symbol);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.value;
  const { candles } = await yahoo.raw(symbol, "1d", "1y");
  const last = candles[candles.length - 1];
  const value = { symbol };
  if (last) {
    const at = (secsAgo) => { const t = last.time - secsAgo; for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= t) return candles[i].close; return candles[0].close; };
    const pct = (base) => (base ? ((last.close - base) / base) * 100 : null);
    const yStart = Date.UTC(new Date(last.time * 1000).getUTCFullYear(), 0, 1) / 1000;
    const beforeYear = candles.filter((c) => c.time < yStart).pop(); // last close of the previous year
    Object.assign(value, {
      w1: pct(at(7 * 86400)), m1: pct(at(30 * 86400)), m3: pct(at(91 * 86400)), m6: pct(at(182 * 86400)),
      ytd: pct(beforeYear?.close ?? candles[0].close), y1: pct(candles[0].close),
    });
  }
  perfCache.set(symbol, { at: Date.now(), value });
  return value;
}

export async function performance(symbols) {
  const out = [];
  const list = symbols.slice(0, 100);
  for (let i = 0; i < list.length; i += 8) {
    const batch = await Promise.allSettled(list.slice(i, i + 8).map(perfOne));
    batch.forEach((r, j) => out.push(r.status === "fulfilled" ? r.value : { symbol: list[i + j], error: true }));
  }
  return out;
}
