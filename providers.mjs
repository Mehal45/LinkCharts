// Market-data providers. Every provider takes a canonical (Yahoo-style) symbol and an interval
// and returns candles [{time (unix s, UTC), open, high, low, close, volume}].
//
// Canonical symbols: RELIANCE.NS / .BO (India), AAPL (US), VOD.L (other exchanges), ^GSPC (index),
// BTC-USD (crypto), EURUSD=X (forex), GC=F (futures).

import { EXTRA_PROVIDERS } from "./providers-extra.mjs";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0 Safari/537.36";

export const INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1d", "1wk", "1mo"];
const SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": 86400, "1wk": 604800, "1mo": 2592000 };

export function marketOf(symbol) {
  if (/\.(NS|BO)$/.test(symbol) || /^\^(NSE|BSE|CNX|NIFTY)/.test(symbol) || symbol === "^BSESN") return "india";
  if (/^[A-Z0-9]{2,12}-(USD|USDT|EUR|INR|GBP|BTC|ETH)$/.test(symbol)) return "crypto";
  if (/=X$/.test(symbol)) return "forex";
  if (/=F$/.test(symbol)) return "futures";
  if (/^[A-Z][A-Z0-9.\-]{0,6}$/.test(symbol) && !/\.[A-Z]{1,3}$/.test(symbol)) return "us";
  if (["^GSPC", "^DJI", "^IXIC", "^RUT", "^VIX", "^NDX"].includes(symbol)) return "us";
  return "global";
}
export const MARKETS = {
  india: "India (NSE/BSE)", us: "US stocks & ETFs", global: "Other exchanges & world indices",
  crypto: "Crypto", forex: "Forex", futures: "Commodities & futures",
};

class ProviderError extends Error {
  constructor(message, status = 502) { super(message); this.status = status; }
}

/** Pulls a human-readable message out of the many error shapes providers use. */
function errorMessage(body) {
  if (!body || typeof body !== "object") return null;
  const e = body.error;
  return (typeof e === "string" ? e : e?.message || e?.description)
    || body.message || body.detail || body["Error Message"] || body.Note || body.Information
    || body.chart?.error?.description || body.errors?.[0]?.message || null;
}

export async function getJson(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, Accept: "application/json", ...opts.headers } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch {
    // Some APIs answer errors in plain text or HTML ("Unauthenticated", nginx 401 pages).
    const plain = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 140);
    throw new ProviderError(res.ok ? `Unexpected response: ${plain}` : `HTTP ${res.status}${plain ? ": " + plain : ""}`, res.status || 502);
  }
  if (!res.ok) throw new ProviderError(errorMessage(body) || `HTTP ${res.status}`, res.status);
  return body;
}

export async function getText(url, opts = {}) {
  const res = await fetch(url, { ...opts, headers: { "User-Agent": UA, ...opts.headers } });
  if (!res.ok) throw new ProviderError(`HTTP ${res.status}`, res.status);
  return res;
}

// ---------------- Yahoo (free, global, no key) ----------------

const YAHOO_RANGE = { "1m": "5d", "5m": "1mo", "15m": "1mo", "30m": "1mo", "60m": "6mo", "1d": "2y", "1wk": "10y", "1mo": "max" };

export function normalizeYahoo(json) {
  const r = json?.chart?.result?.[0];
  if (!r) throw new ProviderError(json?.chart?.error?.description || "No data for this symbol", 404);
  const q = r.indicators?.quote?.[0] || {};
  const ts = r.timestamp || [];
  const candles = [];
  for (let i = 0; i < ts.length; i++) {
    const [o, h, l, c] = [q.open?.[i], q.high?.[i], q.low?.[i], q.close?.[i]];
    if ([o, h, l, c].some((v) => v == null || Number.isNaN(v))) continue;
    candles.push({ time: ts[i], open: o, high: h, low: l, close: c, volume: q.volume?.[i] ?? 0 });
  }
  const m = r.meta;
  const reg = m.currentTradingPeriod?.regular;
  return {
    meta: {
      symbol: m.symbol, name: m.longName || m.shortName || m.symbol, exchange: m.fullExchangeName || m.exchangeName,
      currency: m.currency, type: m.instrumentType, gmtoffset: m.gmtoffset ?? 0, timezone: m.exchangeTimezoneName,
      price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose,
      dayHigh: m.regularMarketDayHigh, dayLow: m.regularMarketDayLow, volume: m.regularMarketVolume,
      high52: m.fiftyTwoWeekHigh, low52: m.fiftyTwoWeekLow, marketTime: m.regularMarketTime,
      session: reg ? { start: reg.start, end: reg.end } : null,
    },
    candles,
  };
}

export const yahoo = {
  id: "yahoo", name: "Yahoo Finance", builtIn: true,
  markets: ["india", "us", "global", "crypto", "forex", "futures"],
  note: "Free, no key. Unofficial endpoints; quotes can be delayed (often 15 min for exchanges).",
  live: false,
  async candles(symbol, interval) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${YAHOO_RANGE[interval]}&includePrePost=false`;
    return normalizeYahoo(await getJson(url)).candles;
  },
  async raw(symbol, interval, range) {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}`;
    return normalizeYahoo(await getJson(url));
  },
};

// ---------------- Binance (free, crypto, live WebSocket, no key) ----------------

const BINANCE_IV = { "1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1h", "1d": "1d", "1wk": "1w", "1mo": "1M" };
export function binanceSymbol(symbol) {
  const m = /^([A-Z0-9]{2,12})-(USD|USDT|EUR|BTC|ETH)$/.exec(symbol);
  if (!m) return null;
  return m[1] + (m[2] === "USD" ? "USDT" : m[2]); // USD pairs map to USDT (≈1:1)
}
export const binance = {
  id: "binance", name: "Binance", builtIn: true, markets: ["crypto"], live: true,
  note: "Free, no key. Real-time crypto candles over WebSocket. USD pairs use USDT.",
  supports: (symbol) => binanceSymbol(symbol) != null,
  async candles(symbol, interval) {
    const pair = binanceSymbol(symbol);
    if (!pair) throw new ProviderError("Not a Binance pair", 400);
    const rows = await getJson(`https://data-api.binance.vision/api/v3/klines?symbol=${pair}&interval=${BINANCE_IV[interval]}&limit=1000`);
    return rows.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] }));
  },
  stream: (symbol, interval) => {
    const pair = binanceSymbol(symbol);
    return pair ? `wss://data-stream.binance.vision/ws/${pair.toLowerCase()}@kline_${BINANCE_IV[interval]}` : null;
  },
};

// ---------------- Fyers (India, user's own API) ----------------

const FYERS_INDEX = { "^NSEI": "NSE:NIFTY50-INDEX", "^NSEBANK": "NSE:NIFTYBANK-INDEX", "^CNXIT": "NSE:NIFTYIT-INDEX", "^BSESN": "BSE:SENSEX-INDEX" };
const FYERS_RES = { "1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60", "1d": "D" };
function fyersSymbol(symbol) {
  if (FYERS_INDEX[symbol]) return FYERS_INDEX[symbol];
  const m = /^(.+)\.(NS|BO)$/.exec(symbol);
  if (!m) return null;
  return m[2] === "NS" ? `NSE:${m[1]}-EQ` : `BSE:${m[1]}-A`;
}
export const fyers = {
  id: "fyers", name: "Fyers API v3", markets: ["india"], live: false,
  note: "Your Fyers app: create one at myapi.fyers.in, log in to get today's access token (it expires daily).",
  fields: [
    { key: "appId", label: "App ID", placeholder: "e.g. XC4EOD67IM-100" },
    { key: "accessToken", label: "Access token", placeholder: "Token from the Fyers login flow", secret: true },
  ],
  testSymbol: "RELIANCE.NS",
  supports: (symbol, interval) => fyersSymbol(symbol) != null && FYERS_RES[interval] != null,
  async candles(symbol, interval, cfg) {
    const sym = fyersSymbol(symbol);
    if (!sym || !FYERS_RES[interval]) throw new ProviderError("Unsupported symbol/interval for Fyers", 400);
    const now = Math.floor(Date.now() / 1000);
    const span = interval === "1d" ? 365 * 86400 : interval === "1m" ? 5 * 86400 : 60 * 86400; // within Fyers' per-request limits
    const url = `https://api-t1.fyers.in/data/history?symbol=${encodeURIComponent(sym)}&resolution=${FYERS_RES[interval]}&date_format=0&range_from=${now - span}&range_to=${now}&cont_flag=1`;
    const body = await getJson(url, { headers: { Authorization: `${cfg.appId}:${cfg.accessToken}` } });
    if (body.s !== "ok") throw new ProviderError(body.message || "Fyers returned an error", 401);
    return (body.candles || []).map(([t, o, h, l, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v }));
  },
};

// ---------------- Twelve Data (global, user's own key) ----------------

const TD_IV = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "1h", "1d": "1day", "1wk": "1week", "1mo": "1month" };
function twelveSymbol(symbol) {
  let m;
  if ((m = /^(.+)\.(NS|BO)$/.exec(symbol))) return { symbol: m[1], exchange: m[2] === "NS" ? "NSE" : "BSE" };
  if ((m = /^([A-Z]{3})([A-Z]{3})=X$/.exec(symbol))) return { symbol: `${m[1]}/${m[2]}` };
  if ((m = /^([A-Z0-9]{2,12})-(USD|EUR|BTC|ETH|INR)$/.exec(symbol))) return { symbol: `${m[1]}/${m[2]}` };
  if (/^[A-Z][A-Z0-9.\-]{0,6}$/.test(symbol)) return { symbol };
  return null;
}
export const twelvedata = {
  id: "twelvedata", name: "Twelve Data", markets: ["us", "global", "forex", "crypto", "india"], live: false,
  note: "Free key at twelvedata.com (800 requests/day). Free plan covers US stocks, forex and crypto; Indian exchanges need a paid plan.",
  fields: [{ key: "apiKey", label: "API key", placeholder: "32-character key", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => twelveSymbol(symbol) != null,
  async candles(symbol, interval, cfg) {
    const s = twelveSymbol(symbol);
    if (!s) throw new ProviderError("Unsupported symbol for Twelve Data", 400);
    const ex = s.exchange ? `&exchange=${s.exchange}` : "";
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(s.symbol)}${ex}&interval=${TD_IV[interval]}&outputsize=5000&timezone=UTC&order=ASC&apikey=${encodeURIComponent(cfg.apiKey)}`;
    const body = await getJson(url);
    if (body.status === "error") throw new ProviderError(body.message || "Twelve Data error", body.code || 400);
    return (body.values || []).map((v) => ({
      time: Math.floor(Date.parse(v.datetime.replace(" ", "T") + (v.datetime.length > 10 ? "Z" : "T00:00:00Z")) / 1000),
      open: +v.open, high: +v.high, low: +v.low, close: +v.close, volume: +(v.volume || 0),
    }));
  },
};

// ---------------- Polygon.io (US, user's own key) ----------------

const POLY_IV = { "1m": [1, "minute"], "5m": [5, "minute"], "15m": [15, "minute"], "30m": [30, "minute"], "60m": [1, "hour"], "1d": [1, "day"], "1wk": [1, "week"], "1mo": [1, "month"] };
function polygonTicker(symbol) {
  let m;
  if ((m = /^([A-Z0-9]{2,12})-(USD)$/.exec(symbol))) return `X:${m[1]}USD`;
  if ((m = /^([A-Z]{6})=X$/.exec(symbol))) return `C:${m[1]}`;
  if (/^[A-Z][A-Z0-9.]{0,6}$/.test(symbol) && marketOf(symbol) === "us") return symbol;
  return null;
}
export const polygon = {
  id: "polygon", name: "Polygon.io (Massive)", markets: ["us", "crypto", "forex"], live: false,
  note: "Free key at polygon.io. Free plan: 5 requests/min, end-of-day/delayed data, 2 years of history.",
  fields: [{ key: "apiKey", label: "API key", placeholder: "Your Polygon key", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => polygonTicker(symbol) != null,
  async candles(symbol, interval, cfg) {
    const t = polygonTicker(symbol);
    if (!t) throw new ProviderError("Unsupported symbol for Polygon", 400);
    const [mult, span] = POLY_IV[interval];
    const days = { minute: 10, hour: 120, day: 730, week: 3650, month: 3650 }[span];
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
    const url = `https://api.polygon.io/v2/aggs/ticker/${encodeURIComponent(t)}/range/${mult}/${span}/${from}/${to}?adjusted=true&sort=asc&limit=50000&apiKey=${encodeURIComponent(cfg.apiKey)}`;
    const body = await getJson(url);
    if (body.status === "ERROR" || body.status === "NOT_AUTHORIZED") throw new ProviderError(body.error || body.message || "Polygon error", 401);
    return (body.results || []).map((r) => ({ time: Math.floor(r.t / 1000), open: r.o, high: r.h, low: r.l, close: r.c, volume: r.v ?? 0 }));
  },
};

// Order here is the order shown in Settings: free built-ins first, then Indian brokers, then global APIs.
export const PROVIDERS = {
  yahoo, binance, ...pick(EXTRA_PROVIDERS, "coinbase", "kraken", "upstox", "coingecko"),
  fyers, ...pick(EXTRA_PROVIDERS, "kite"),
  twelvedata, polygon, ...pick(EXTRA_PROVIDERS, "alpaca", "tiingo", "fmp", "eodhd", "marketstack", "alphavantage", "tradier"),
};
function pick(obj, ...keys) { return Object.fromEntries(keys.map((k) => [k, obj[k]])); }
export const barSeconds = (interval) => SECONDS[interval];
export { ProviderError };
