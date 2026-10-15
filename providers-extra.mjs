// Additional market-data providers. Same contract as providers.mjs:
// candles(symbol, interval, cfg) → [{ time (unix s, UTC), open, high, low, close, volume }] sorted ascending.
import zlib from "node:zlib";
import { promisify } from "node:util";
import { getJson, getText, ProviderError } from "./providers.mjs";

const gunzip = promisify(zlib.gunzip);
const DAY = 86400;
const now = () => Math.floor(Date.now() / 1000);
const isoDate = (unix) => new Date(unix * 1000).toISOString().slice(0, 10);

// ---------------- shared helpers ----------------

/** Seconds east of UTC for a timezone at a given instant (handles DST). */
function tzOffset(utcMs, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(new Date(utcMs)).map((x) => [x.type, x.value]));
  return (Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - utcMs) / 1000;
}

/** "2026-10-14 15:55:00" in a named timezone → unix seconds. Date-only strings become 12:00 UTC (safe for daily bars). */
export function toUnix(str, tz = "UTC") {
  if (typeof str === "number") return str > 1e12 ? Math.floor(str / 1000) : str;
  if (/[zZ]$|[+-]\d\d:?\d\d$/.test(str)) return Math.floor(Date.parse(str) / 1000); // already has an offset
  const [d, t] = str.trim().split(/[ T]/);
  const [Y, M, D] = d.split("-").map(Number);
  if (!t) return Date.UTC(Y, M - 1, D, 12) / 1000;
  const [h, m, s = 0] = t.split(":").map(Number);
  const guess = Date.UTC(Y, M - 1, D, h, m, s);
  return Math.floor(guess / 1000 - tzOffset(guess, tz));
}

const SECONDS = { "1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600, "1d": DAY, "1wk": 7 * DAY, "1mo": 30 * DAY };

/** Merges finer candles into a coarser interval (e.g. 5m → 15m, daily → weekly/monthly). */
export function resample(candles, interval) {
  const key = interval === "1mo" ? (t) => { const d = new Date(t * 1000); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1) / 1000; }
    : interval === "1wk" ? (t) => { const d = Math.floor(t / DAY); return (d - ((d + 3) % 7)) * DAY; } // Monday
    : (t) => t - (t % SECONDS[interval]);
  const out = [];
  for (const c of candles) {
    const k = key(c.time);
    const last = out[out.length - 1];
    if (last && last._k === k) {
      last.high = Math.max(last.high, c.high);
      last.low = Math.min(last.low, c.low);
      last.close = c.close;
      last.volume += c.volume || 0;
    } else out.push({ _k: k, time: interval === "1wk" || interval === "1mo" ? c.time : k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume || 0 });
  }
  return out.map(({ _k, ...c }) => c);
}

const sortAsc = (candles) => candles.filter((c) => [c.open, c.high, c.low, c.close].every(Number.isFinite)).sort((a, b) => a.time - b.time);

/** Splits a canonical symbol into parts. */
function parse(symbol) {
  let m;
  if ((m = /^(.+)\.(NS|BO)$/.exec(symbol))) return { kind: "india", base: m[1], exchange: m[2] === "NS" ? "NSE" : "BSE" };
  if ((m = /^([A-Z0-9]{2,12})-(USD|USDT|EUR|GBP|INR|BTC|ETH)$/.exec(symbol))) return { kind: "crypto", base: m[1], quote: m[2] };
  if ((m = /^([A-Z]{3})([A-Z]{3})=X$/.exec(symbol))) return { kind: "forex", base: m[1], quote: m[2] };
  if (/^\^/.test(symbol)) return { kind: "index", base: symbol.slice(1) };
  if (/=F$/.test(symbol)) return { kind: "futures", base: symbol };
  if ((m = /^([A-Z0-9\-]+)\.([A-Z]{1,3})$/.exec(symbol))) return { kind: "global", base: m[1], suffix: m[2] };
  if (/^[A-Z][A-Z0-9.\-]{0,6}$/.test(symbol)) return { kind: "us", base: symbol };
  return { kind: "other", base: symbol };
}

const INDIA_INDEX = {
  "^NSEI": { upstox: "NSE_INDEX|Nifty 50", kite: 256265 },
  "^NSEBANK": { upstox: "NSE_INDEX|Nifty Bank", kite: 260105 },
  "^CNXIT": { upstox: "NSE_INDEX|Nifty IT", kite: 259849 },
  "^BSESN": { upstox: "BSE_INDEX|SENSEX", kite: 265 },
};

// ======================================================================
// FREE (no key)
// ======================================================================

// ---------------- Coinbase Exchange ----------------
const CB_GRAN = { "1m": 60, "5m": 300, "15m": 900, "60m": 3600, "1d": DAY };
export const coinbase = {
  id: "coinbase", name: "Coinbase Exchange", builtIn: true, markets: ["crypto"], live: false,
  note: "Free, no key. Crypto against USD/EUR/GBP (e.g. BTC-USD). 30m, weekly and monthly are built from finer candles.",
  supports: (symbol) => { const p = parse(symbol); return p.kind === "crypto" && ["USD", "EUR", "GBP", "USDT"].includes(p.quote); },
  async candles(symbol, interval) {
    const p = parse(symbol);
    const product = `${p.base}-${p.quote === "USDT" ? "USD" : p.quote}`;
    const base = interval === "30m" ? "15m" : interval === "1wk" || interval === "1mo" ? "1d" : interval;
    const g = CB_GRAN[base];
    const windows = interval === "1mo" ? 8 : interval === "1wk" ? 4 : 3; // Coinbase returns ≤300 candles per call
    const out = [];
    let end = now();
    for (let w = 0; w < windows; w++) {
      const start = end - 300 * g;
      const rows = await getJson(`https://api.exchange.coinbase.com/products/${product}/candles?granularity=${g}&start=${new Date(start * 1000).toISOString()}&end=${new Date(end * 1000).toISOString()}`);
      if (!Array.isArray(rows) || !rows.length) break;
      // [time, low, high, open, close, volume]
      out.push(...rows.map(([t, l, h, o, c, v]) => ({ time: t, open: o, high: h, low: l, close: c, volume: v })));
      end = start;
    }
    const asc = sortAsc(out);
    return base === interval ? asc : resample(asc, interval);
  },
};

// ---------------- Kraken ----------------
const KR_IV = { "1m": 1, "5m": 5, "15m": 15, "30m": 30, "60m": 60, "1d": 1440, "1wk": 10080 };
export const kraken = {
  id: "kraken", name: "Kraken", builtIn: true, markets: ["crypto"], live: false,
  note: "Free, no key. Up to 720 recent candles per interval; monthly is built from weekly data.",
  supports: (symbol) => { const p = parse(symbol); return p.kind === "crypto" && ["USD", "EUR", "GBP", "USDT", "BTC", "ETH"].includes(p.quote); },
  async candles(symbol, interval) {
    const p = parse(symbol);
    const pair = `${p.base === "BTC" ? "XBT" : p.base}${p.quote === "BTC" ? "XBT" : p.quote}`;
    const iv = KR_IV[interval === "1mo" ? "1wk" : interval];
    const body = await getJson(`https://api.kraken.com/0/public/OHLC?pair=${pair}&interval=${iv}`);
    if (body.error?.length) throw new ProviderError(body.error.join(", "), 400);
    const key = Object.keys(body.result || {}).find((k) => k !== "last");
    // [time, open, high, low, close, vwap, volume, count]
    const asc = sortAsc((body.result?.[key] || []).map((r) => ({ time: r[0], open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[6] })));
    return interval === "1mo" ? resample(asc, "1mo") : asc;
  },
};

// ---------------- Upstox (public historical API, India) ----------------
// Historical + intraday candles don't need a login. Symbols map to Upstox instrument keys via
// their public instrument list (cached for a day).
let upstoxMap = null; // { at, map: Map("NSE:RELIANCE" → "NSE_EQ|INE002A01018") }
async function upstoxKey(symbol) {
  if (INDIA_INDEX[symbol]) return INDIA_INDEX[symbol].upstox;
  const p = parse(symbol);
  if (p.kind !== "india") return null;
  if (!upstoxMap || Date.now() - upstoxMap.at > DAY * 1000) {
    const map = new Map();
    for (const ex of ["NSE", "BSE"]) {
      const res = await getText(`https://assets.upstox.com/market-quote/instruments/exchange/${ex}.json.gz`);
      const rows = JSON.parse((await gunzip(Buffer.from(await res.arrayBuffer()))).toString("utf8"));
      for (const r of rows) if (r.segment === `${ex}_EQ`) map.set(`${ex}:${r.trading_symbol}`, r.instrument_key);
    }
    upstoxMap = { at: Date.now(), map };
  }
  return upstoxMap.map.get(`${p.exchange}:${p.base}`) || null;
}
const UPX_UNIT = { "1m": ["minutes", 1], "5m": ["minutes", 5], "15m": ["minutes", 15], "30m": ["minutes", 30], "60m": ["hours", 1], "1d": ["days", 1], "1wk": ["weeks", 1], "1mo": ["months", 1] };
const UPX_SPAN = { "1m": 7, "5m": 30, "15m": 30, "30m": 90, "60m": 90, "1d": 730, "1wk": 3650, "1mo": 3650 };
export const upstox = {
  id: "upstox", name: "Upstox (public history)", builtIn: true, markets: ["india"], live: false,
  note: "Free, no key. Broker-grade NSE/BSE candles (incl. today's intraday) from Upstox's public historical API. First use downloads Upstox's symbol list (~4 MB).",
  supports: (symbol) => !!INDIA_INDEX[symbol] || parse(symbol).kind === "india",
  async candles(symbol, interval) {
    const key = await upstoxKey(symbol);
    if (!key) throw new ProviderError("Symbol not found in Upstox's instrument list", 404);
    const [unit, n] = UPX_UNIT[interval];
    const k = encodeURIComponent(key);
    const to = isoDate(now()), from = isoDate(now() - UPX_SPAN[interval] * DAY);
    const hist = await getJson(`https://api.upstox.com/v3/historical-candle/${k}/${unit}/${n}/${to}/${from}`);
    let rows = hist?.data?.candles || [];
    if (["minutes", "hours", "days"].includes(unit)) {
      // Today's bars live in a separate intraday endpoint.
      try {
        const intra = await getJson(`https://api.upstox.com/v3/historical-candle/intraday/${k}/${unit}/${n}`);
        rows = rows.concat(intra?.data?.candles || []);
      } catch { /* market closed or holiday */ }
    }
    const seen = new Set();
    // Daily+ bars are stamped local midnight ("…T00:00:00+05:30"); keep the calendar date, not the UTC instant.
    const daily = !["minutes", "hours"].includes(unit);
    return sortAsc(rows.map(([t, o, h, l, c, v]) => ({ time: daily ? toUnix(t.slice(0, 10)) : toUnix(t), open: o, high: h, low: l, close: c, volume: v })))
      .filter((c) => !seen.has(c.time) && seen.add(c.time));
  },
};

// ---------------- CoinGecko (optional demo key) ----------------
const cgIds = new Map();
async function coingeckoId(base, key) {
  if (cgIds.has(base)) return cgIds.get(base);
  const body = await getJson(`https://api.coingecko.com/api/v3/search?query=${encodeURIComponent(base)}`, { headers: key ? { "x-cg-demo-api-key": key } : {} });
  const coin = (body.coins || []).filter((c) => c.symbol?.toUpperCase() === base).sort((a, b) => (a.market_cap_rank ?? 1e9) - (b.market_cap_rank ?? 1e9))[0];
  if (!coin) throw new ProviderError(`CoinGecko has no coin with symbol ${base}`, 404);
  cgIds.set(base, coin.id);
  return coin.id;
}
export const coingecko = {
  id: "coingecko", name: "CoinGecko", markets: ["crypto"], live: false,
  note: "Works without a key (rate-limited); a free Demo key raises the limit. Covers thousands of coins; candles are built from CoinGecko price points, so intraday wicks are approximate.",
  fields: [{ key: "apiKey", label: "Demo API key (optional)", placeholder: "CG-…", secret: true, optional: true }],
  testSymbol: "BTC-USD",
  supports: (symbol, interval) => parse(symbol).kind === "crypto" && !["1m"].includes(interval),
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const id = await coingeckoId(p.base, cfg.apiKey);
    const vs = (p.quote === "USDT" ? "usd" : p.quote).toLowerCase();
    const days = { "5m": 1, "15m": 1, "30m": 2, "60m": 30, "1d": 365, "1wk": 365, "1mo": 365 }[interval];
    const body = await getJson(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=${vs}&days=${days}`, { headers: cfg.apiKey ? { "x-cg-demo-api-key": cfg.apiKey } : {} });
    // Price points → candles: each point becomes a bar that opens at the previous price.
    const pts = (body.prices || []).map(([t, v]) => ({ time: Math.floor(t / 1000), price: v }));
    const raw = pts.map((x, i) => {
      const o = i ? pts[i - 1].price : x.price;
      return { time: x.time, open: o, high: Math.max(o, x.price), low: Math.min(o, x.price), close: x.price, volume: 0 };
    });
    return resample(raw, interval);
  },
};

// ======================================================================
// INDIAN BROKERS
// ======================================================================

// ---------------- Zerodha Kite Connect ----------------
let kiteInstruments = null; // { at, map: Map("NSE:RELIANCE" → token) }
async function kiteToken(symbol) {
  if (INDIA_INDEX[symbol]) return INDIA_INDEX[symbol].kite;
  const p = parse(symbol);
  if (p.kind !== "india") return null;
  if (!kiteInstruments || Date.now() - kiteInstruments.at > DAY * 1000) {
    const map = new Map();
    for (const ex of ["NSE", "BSE"]) {
      const csv = await (await getText(`https://api.kite.trade/instruments/${ex}`)).text();
      for (const line of csv.split("\n").slice(1)) {
        const [token, , tradingsymbol] = line.split(",");
        if (token && tradingsymbol) map.set(`${ex}:${tradingsymbol}`, +token);
      }
    }
    kiteInstruments = { at: Date.now(), map };
  }
  return kiteInstruments.map.get(`${p.exchange}:${p.base}`) || null;
}
const KITE_IV = { "1m": "minute", "5m": "5minute", "15m": "15minute", "30m": "30minute", "60m": "60minute", "1d": "day", "1wk": "day", "1mo": "day" };
const KITE_SPAN = { "1m": 30, "5m": 90, "15m": 180, "30m": 180, "60m": 365, "1d": 1800, "1wk": 1800, "1mo": 1800 };
export const kite = {
  id: "kite", name: "Zerodha Kite Connect", markets: ["india"], live: false,
  note: "Needs a Kite Connect app (kite.trade) with the historical data add-on. The access token expires every morning — paste a fresh one daily.",
  fields: [
    { key: "apiKey", label: "API key", placeholder: "Your Kite app's api_key" },
    { key: "accessToken", label: "Access token", placeholder: "From the Kite login flow", secret: true },
  ],
  testSymbol: "RELIANCE.NS",
  supports: (symbol) => !!INDIA_INDEX[symbol] || parse(symbol).kind === "india",
  async candles(symbol, interval, cfg) {
    const token = await kiteToken(symbol);
    if (!token) throw new ProviderError("Symbol not in Kite's instrument list", 404);
    const fmt = (u) => new Date((u + 19800) * 1000).toISOString().slice(0, 19).replace("T", "+");
    const to = now(), from = to - KITE_SPAN[interval] * DAY;
    const body = await getJson(`https://api.kite.trade/instruments/historical/${token}/${KITE_IV[interval]}?from=${fmt(from)}&to=${fmt(to)}`, {
      headers: { "X-Kite-Version": "3", Authorization: `token ${cfg.apiKey}:${cfg.accessToken}` },
    });
    const daily = KITE_IV[interval] === "day"; // day candles are stamped local midnight: keep the calendar date
    const asc = sortAsc((body.data?.candles || []).map(([t, o, h, l, c, v]) => ({ time: daily ? toUnix(t.slice(0, 10)) : toUnix(t), open: o, high: h, low: l, close: c, volume: v })));
    return interval === "1wk" || interval === "1mo" ? resample(asc, interval) : asc;
  },
};

// ======================================================================
// GLOBAL DATA APIS (your own key)
// ======================================================================

// ---------------- Alpha Vantage ----------------
const AV_IV = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "60min" };
export const alphavantage = {
  id: "alphavantage", name: "Alpha Vantage", markets: ["us", "global", "india", "forex", "crypto"], live: false,
  note: "Free key at alphavantage.co (25 requests/day). Intraday is US-only; BSE stocks work on daily+. Daily history on the free plan is the last ~100 days.",
  fields: [{ key: "apiKey", label: "API key", placeholder: "Your Alpha Vantage key", secret: true }],
  testSymbol: "IBM",
  supports: (symbol, interval) => {
    const p = parse(symbol);
    if (p.kind === "india") return p.exchange === "BSE" && !AV_IV[interval];
    if (p.kind === "forex" || p.kind === "crypto") return !AV_IV[interval];
    return p.kind === "us" || (p.kind === "global" && !AV_IV[interval]);
  },
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const k = `&apikey=${encodeURIComponent(cfg.apiKey)}`;
    let url;
    if (p.kind === "forex") url = `function=FX_${{ "1d": "DAILY", "1wk": "WEEKLY", "1mo": "MONTHLY" }[interval]}&from_symbol=${p.base}&to_symbol=${p.quote}`;
    else if (p.kind === "crypto") url = `function=DIGITAL_CURRENCY_${{ "1d": "DAILY", "1wk": "WEEKLY", "1mo": "MONTHLY" }[interval]}&symbol=${p.base}&market=${p.quote === "USDT" ? "USD" : p.quote}`;
    else {
      const sym = p.kind === "india" ? `${p.base}.BSE` : p.kind === "global" ? `${p.base}.${p.suffix === "L" ? "LON" : p.suffix}` : p.base;
      url = AV_IV[interval]
        ? `function=TIME_SERIES_INTRADAY&symbol=${sym}&interval=${AV_IV[interval]}&outputsize=full`
        : `function=TIME_SERIES_${{ "1d": "DAILY", "1wk": "WEEKLY", "1mo": "MONTHLY" }[interval]}&symbol=${sym}`;
    }
    const body = await getJson(`https://www.alphavantage.co/query?${url}${k}`);
    if (body["Error Message"] || body.Note || body.Information) throw new ProviderError(body["Error Message"] || body.Note || body.Information, 429);
    const seriesKey = Object.keys(body).find((x) => /Time Series/i.test(x));
    if (!seriesKey) throw new ProviderError("Alpha Vantage returned no series", 404);
    const tz = body["Meta Data"]?.["6. Time Zone"] || body["Meta Data"]?.["7. Time Zone"] || "US/Eastern";
    const pick = (v, n) => +(v[`${n}`] ?? Object.entries(v).find(([kk]) => kk.includes(n.split(". ")[1]))?.[1]);
    return sortAsc(Object.entries(body[seriesKey]).map(([t, v]) => ({
      time: toUnix(t, tz === "US/Eastern" ? "America/New_York" : tz),
      open: pick(v, "1. open"), high: pick(v, "2. high"), low: pick(v, "3. low"), close: pick(v, "4. close"), volume: +(v["5. volume"] ?? 0),
    })));
  },
};

// ---------------- Tiingo ----------------
const TI_IV = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "1hour" };
export const tiingo = {
  id: "tiingo", name: "Tiingo", markets: ["us", "crypto", "forex"], live: false,
  note: "Free key at tiingo.com. US end-of-day history back decades, IEX intraday, plus crypto and forex.",
  fields: [{ key: "apiKey", label: "API token", placeholder: "Your Tiingo token", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => ["us", "crypto", "forex"].includes(parse(symbol).kind),
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const auth = { headers: { Authorization: `Token ${cfg.apiKey}` } };
    const intraday = !!TI_IV[interval];
    const freq = intraday ? TI_IV[interval] : "1day";
    const start = isoDate(now() - (intraday ? 20 : 3650) * DAY);
    let rows;
    if (p.kind === "crypto") {
      const body = await getJson(`https://api.tiingo.com/tiingo/crypto/prices?tickers=${p.base.toLowerCase()}${(p.quote === "USDT" ? "usd" : p.quote).toLowerCase()}&resampleFreq=${freq}&startDate=${start}`, auth);
      rows = body?.[0]?.priceData || [];
    } else if (p.kind === "forex") {
      rows = await getJson(`https://api.tiingo.com/tiingo/fx/${(p.base + p.quote).toLowerCase()}/prices?resampleFreq=${freq}&startDate=${start}`, auth);
    } else if (intraday) {
      rows = await getJson(`https://api.tiingo.com/iex/${p.base.toLowerCase()}/prices?resampleFreq=${freq}&startDate=${start}&columns=open,high,low,close,volume`, auth);
    } else {
      rows = await getJson(`https://api.tiingo.com/tiingo/daily/${p.base.toLowerCase()}/prices?startDate=${start}&resampleFreq=${{ "1d": "daily", "1wk": "weekly", "1mo": "monthly" }[interval]}`, auth);
    }
    const asc = sortAsc(rows.map((r) => ({
      time: intraday ? toUnix(r.date) : toUnix(r.date.slice(0, 10)),
      open: r.adjOpen ?? r.open, high: r.adjHigh ?? r.high, low: r.adjLow ?? r.low, close: r.adjClose ?? r.close, volume: r.adjVolume ?? r.volume ?? 0,
    })));
    return !intraday && (p.kind === "crypto" || p.kind === "forex") && interval !== "1d" ? resample(asc, interval) : asc;
  },
};

// ---------------- Financial Modeling Prep ----------------
const FMP_IV = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "1hour" };
export const fmp = {
  id: "fmp", name: "Financial Modeling Prep", markets: ["us", "global", "india", "forex", "crypto"], live: false,
  note: "Free key at financialmodelingprep.com (250 requests/day, US stocks). Indian, international, forex and crypto symbols need a paid plan.",
  fields: [{ key: "apiKey", label: "API key", placeholder: "Your FMP key", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => ["us", "global", "india", "forex", "crypto"].includes(parse(symbol).kind),
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const sym = p.kind === "forex" ? p.base + p.quote : p.kind === "crypto" ? p.base + (p.quote === "USDT" ? "USD" : p.quote) : symbol;
    const k = `&apikey=${encodeURIComponent(cfg.apiKey)}`;
    if (FMP_IV[interval]) {
      const rows = await getJson(`https://financialmodelingprep.com/stable/historical-chart/${FMP_IV[interval]}?symbol=${encodeURIComponent(sym)}${k}`);
      if (!Array.isArray(rows)) throw new ProviderError("FMP returned no data", 404);
      const tz = p.kind === "us" ? "America/New_York" : p.kind === "india" ? "Asia/Kolkata" : "UTC";
      return sortAsc(rows.map((r) => ({ time: toUnix(r.date, tz), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })));
    }
    const from = isoDate(now() - 3650 * DAY);
    const body = await getJson(`https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=${encodeURIComponent(sym)}&from=${from}${k}`);
    const rows = Array.isArray(body) ? body : body?.historical || [];
    const asc = sortAsc(rows.map((r) => ({ time: toUnix(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })));
    return interval === "1d" ? asc : resample(asc, interval);
  },
};

// ---------------- EODHD (EOD Historical Data) ----------------
const EOD_SUFFIX = { NS: "NSE", BO: "BSE", L: "LSE", T: "TSE", HK: "HK", TO: "TO", AX: "AU", DE: "XETRA", PA: "PA", AS: "AS", SW: "SW", MI: "MI", MC: "MC", KS: "KO", SS: "SHG", SZ: "SHE", SI: "SG", SA: "SA", JO: "JSE" };
function eodSymbol(symbol) {
  const p = parse(symbol);
  if (p.kind === "india") return `${p.base}.${p.exchange}`;
  if (p.kind === "us") return `${p.base}.US`;
  if (p.kind === "forex") return `${p.base}${p.quote}.FOREX`;
  if (p.kind === "crypto") return `${p.base}-${p.quote === "USDT" ? "USD" : p.quote}.CC`;
  if (p.kind === "index") return `${p.base}.INDX`;
  if (p.kind === "global" && EOD_SUFFIX[p.suffix]) return `${p.base}.${EOD_SUFFIX[p.suffix]}`;
  return null;
}
export const eodhd = {
  id: "eodhd", name: "EODHD", markets: ["india", "us", "global", "forex", "crypto"], live: false,
  note: "Key at eodhd.com. 70+ exchanges including NSE/BSE, plus indices, forex and crypto. Free plan: 20 requests/day, 1 year of end-of-day data.",
  fields: [{ key: "apiKey", label: "API token", placeholder: "Your EODHD token", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => eodSymbol(symbol) != null,
  async candles(symbol, interval, cfg) {
    const sym = eodSymbol(symbol);
    const k = `api_token=${encodeURIComponent(cfg.apiKey)}&fmt=json`;
    const intraday = ["1m", "5m", "15m", "30m", "60m"].includes(interval);
    if (intraday) {
      const iv = interval === "1m" ? "1m" : interval === "60m" ? "1h" : "5m";
      const span = interval === "1m" ? 7 : interval === "60m" ? 120 : 30;
      const rows = await getJson(`https://eodhd.com/api/intraday/${encodeURIComponent(sym)}?${k}&interval=${iv}&from=${now() - span * DAY}&to=${now()}`);
      const asc = sortAsc(rows.map((r) => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })));
      return interval === "15m" || interval === "30m" ? resample(asc, interval) : asc;
    }
    const period = { "1d": "d", "1wk": "w", "1mo": "m" }[interval];
    const rows = await getJson(`https://eodhd.com/api/eod/${encodeURIComponent(sym)}?${k}&period=${period}&from=${isoDate(now() - 3650 * DAY)}`);
    return sortAsc(rows.map((r) => ({ time: toUnix(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 })));
  },
};

// ---------------- Marketstack ----------------
const MS_MIC = { NS: "XNSE", BO: "XBOM", L: "XLON", T: "XTKS", HK: "XHKG", TO: "XTSE", AX: "XASX", DE: "XETR", PA: "XPAR" };
const MS_IV = { "1m": "1min", "5m": "5min", "15m": "15min", "30m": "30min", "60m": "1hour" };
export const marketstack = {
  id: "marketstack", name: "Marketstack", markets: ["us", "global", "india"], live: false,
  note: "Key at marketstack.com. 70+ exchanges (NSE as XNSE). Free plan: 100 requests/month, end-of-day only; intraday needs a paid plan.",
  fields: [{ key: "apiKey", label: "Access key", placeholder: "Your Marketstack access key", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol) => { const p = parse(symbol); return p.kind === "us" || ((p.kind === "india" || p.kind === "global") && !!MS_MIC[p.kind === "india" ? (p.exchange === "NSE" ? "NS" : "BO") : p.suffix]); },
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const sym = p.kind === "us" ? p.base : `${p.base}.${MS_MIC[p.kind === "india" ? (p.exchange === "NSE" ? "NS" : "BO") : p.suffix]}`;
    const k = `access_key=${encodeURIComponent(cfg.apiKey)}`;
    const intraday = !!MS_IV[interval];
    const url = intraday
      ? `https://api.marketstack.com/v2/intraday?${k}&symbols=${encodeURIComponent(sym)}&interval=${MS_IV[interval]}&limit=1000`
      : `https://api.marketstack.com/v2/eod?${k}&symbols=${encodeURIComponent(sym)}&limit=1000&date_from=${isoDate(now() - 1460 * DAY)}`;
    const body = await getJson(url);
    const asc = sortAsc((body.data || []).map((r) => ({ time: intraday ? toUnix(r.date) : toUnix(r.date.slice(0, 10)), open: r.open, high: r.high, low: r.low, close: r.close ?? r.last, volume: r.volume ?? 0 })));
    return intraday || interval === "1d" ? asc : resample(asc, interval);
  },
};

// ---------------- Alpaca ----------------
const AL_TF = { "1m": "1Min", "5m": "5Min", "15m": "15Min", "30m": "30Min", "60m": "1Hour", "1d": "1Day", "1wk": "1Week", "1mo": "1Month" };
const AL_SPAN = { "1m": 5, "5m": 30, "15m": 60, "30m": 90, "60m": 180, "1d": 1825, "1wk": 3650, "1mo": 3650 };
export const alpaca = {
  id: "alpaca", name: "Alpaca", markets: ["us", "crypto"], live: false,
  note: "Free account at alpaca.markets (paper trading keys work). US stocks on the free IEX feed with years of history, plus crypto.",
  fields: [
    { key: "keyId", label: "API key ID", placeholder: "PK…" },
    { key: "secret", label: "Secret key", placeholder: "Your secret key", secret: true },
  ],
  testSymbol: "AAPL",
  supports: (symbol) => { const p = parse(symbol); return p.kind === "us" || (p.kind === "crypto" && ["USD", "USDT", "BTC"].includes(p.quote)); },
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const headers = { "APCA-API-KEY-ID": cfg.keyId, "APCA-API-SECRET-KEY": cfg.secret };
    const start = new Date((now() - AL_SPAN[interval] * DAY) * 1000).toISOString();
    const out = [];
    let pageToken = null;
    for (let page = 0; page < 5; page++) {
      const pt = pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : "";
      let bars;
      if (p.kind === "crypto") {
        const pair = `${p.base}/${p.quote === "USDT" ? "USD" : p.quote}`;
        const body = await getJson(`https://data.alpaca.markets/v1beta3/crypto/us/bars?symbols=${encodeURIComponent(pair)}&timeframe=${AL_TF[interval]}&start=${start}&limit=10000${pt}`, { headers });
        bars = body.bars?.[pair] || [];
        pageToken = body.next_page_token;
      } else {
        const body = await getJson(`https://data.alpaca.markets/v2/stocks/${encodeURIComponent(p.base)}/bars?timeframe=${AL_TF[interval]}&start=${start}&limit=10000&adjustment=split&feed=iex${pt}`, { headers });
        bars = body.bars || [];
        pageToken = body.next_page_token;
      }
      out.push(...bars.map((b) => ({ time: toUnix(b.t), open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v })));
      if (!pageToken) break;
    }
    return sortAsc(out);
  },
};

// ---------------- Tradier ----------------
const TR_IV = { "1m": "1min", "5m": "5min", "15m": "15min" };
export const tradier = {
  id: "tradier", name: "Tradier", markets: ["us"], live: false,
  note: "Brokerage or free sandbox account at tradier.com. US stocks, ETFs and indices; intraday (1/5/15 min) covers the last ~20 days. Sandbox tokens are detected automatically.",
  fields: [{ key: "token", label: "Access token", placeholder: "Your Tradier token", secret: true }],
  testSymbol: "AAPL",
  supports: (symbol, interval) => parse(symbol).kind === "us" && interval !== "30m" && interval !== "60m",
  async candles(symbol, interval, cfg) {
    const p = parse(symbol);
    const call = async (host) => {
      const headers = { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" };
      if (TR_IV[interval]) {
        const start = new Date((now() - 18 * DAY) * 1000).toISOString().slice(0, 16).replace("T", " ");
        const body = await getJson(`https://${host}/v1/markets/timesales?symbol=${p.base}&interval=${TR_IV[interval]}&start=${encodeURIComponent(start)}&session_filter=open`, { headers });
        const data = body.series?.data || [];
        return (Array.isArray(data) ? data : [data]).map((r) => ({ time: r.timestamp, open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }));
      }
      const body = await getJson(`https://${host}/v1/markets/history?symbol=${p.base}&interval=${{ "1d": "daily", "1wk": "weekly", "1mo": "monthly" }[interval]}&start=${isoDate(now() - 3650 * DAY)}`, { headers });
      const days = body.history?.day || [];
      return (Array.isArray(days) ? days : [days]).map((r) => ({ time: toUnix(r.date), open: r.open, high: r.high, low: r.low, close: r.close, volume: r.volume ?? 0 }));
    };
    try { return sortAsc(await call("api.tradier.com")); } catch (err) {
      if (err.status === 401) return sortAsc(await call("sandbox.tradier.com")); // sandbox token
      throw err;
    }
  },
};

export const EXTRA_PROVIDERS = { coinbase, kraken, upstox, coingecko, kite, alphavantage, tiingo, fmp, eodhd, marketstack, alpaca, tradier };
