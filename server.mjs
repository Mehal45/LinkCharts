// LinkCharts server: static files + market-data API with pluggable providers.
// Binds to 127.0.0.1 only, because it stores your API keys in data/config.json.
// Usage: node server.mjs [port] [--open]   (--open launches the browser once it's running)
import http from "node:http";
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PROVIDERS, MARKETS, INTERVALS, marketOf, yahoo, ProviderError } from "./providers.mjs";
import { runScreen, performance, SCREENER_MARKETS, SECTORS } from "./screener.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.LINKCHARTS_PORT || process.argv.slice(2).find((a) => /^\d+$/.test(a)) || 5174);
// The installed app keeps its data in the user's app-data folder (the install folder is replaced on updates).
const dataDir = process.env.LINKCHARTS_DATA || path.join(root, "data");
const openBrowser = process.argv.includes("--open");
function launchBrowser(url) {
  const cmd = process.platform === "win32" ? `start "" "${url}"` : process.platform === "darwin" ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => { /* no browser to launch; the URL is printed above */ });
}
const configPath = path.join(dataDir, "config.json");
// Everything the app remembers (watchlists, alerts, drawings, paper trades, layouts, theme…)
// is mirrored here so it survives cleared browser data or a different browser.
const userDataPath = path.join(dataDir, "userdata.json");
function readUserData() {
  try { return JSON.parse(fs.readFileSync(userDataPath, "utf8")); } catch { return { savedAt: 0, items: {} }; }
}
function writeUserData(data) {
  fs.mkdirSync(path.dirname(userDataPath), { recursive: true });
  const tmp = userDataPath + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, userDataPath); // atomic: a crash mid-write never leaves a half-written file
}
const types = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml" };
const SYMBOL_RE = /^[\^A-Z0-9&.\-=]{1,30}$/i;

// ---------------- config (API keys + routing) ----------------

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath, "utf8")); } catch { return { providers: {}, routing: {} }; }
}
function saveConfig(cfg) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2));
}
let config = loadConfig();
config.providers ??= {};
config.routing ??= {};

const isConfigured = (id) => {
  const p = PROVIDERS[id];
  if (p.builtIn) return true;
  const c = config.providers[id];
  return p.fields.every((f) => f.optional || c?.[f.key]);
};
const mask = (v) => (v ? `••••${String(v).slice(-4)}` : "");

/** Default source order per market when routing is "auto". */
// Free sources other than Yahoo/Binance (Upstox, Coinbase, Kraken, CoinGecko) are opt-in via
// the per-market table, so the automatic order only reaches for them as a fallback.
const AUTO_ORDER = {
  india: ["kite", "fyers", "eodhd", "twelvedata", "yahoo", "upstox"],
  us: ["alpaca", "polygon", "tiingo", "twelvedata", "fmp", "eodhd", "tradier", "marketstack", "alphavantage", "yahoo"],
  global: ["eodhd", "twelvedata", "fmp", "marketstack", "alphavantage", "yahoo"],
  crypto: ["binance", "coinbase", "alpaca", "tiingo", "twelvedata", "polygon", "kraken", "yahoo", "coingecko"],
  forex: ["twelvedata", "polygon", "tiingo", "fmp", "eodhd", "alphavantage", "yahoo"],
  futures: ["yahoo"],
};
// A key-less provider (like CoinGecko without its optional key) only joins "auto" when the user saved settings for it.
const keyOptional = (id) => PROVIDERS[id].fields?.length && PROVIDERS[id].fields.every((f) => f.optional);

function candidateSources(symbol, interval) {
  const market = marketOf(symbol);
  const chosen = config.routing[market];
  const explicit = chosen && chosen !== "auto";
  const order = explicit ? [chosen, "yahoo"] : AUTO_ORDER[market];
  return [...new Set(order)].filter((id) => {
    const p = PROVIDERS[id];
    if (!p || !isConfigured(id) || !p.markets.includes(market) || (p.supports && !p.supports(symbol, interval))) return false;
    return explicit || !keyOptional(id) || !!config.providers[id];
  });
}

// ---------------- caching ----------------

const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 800) cache.delete(cache.keys().next().value);
  return value;
}

// Yahoo's chartPreviousClose is the close before the *requested range*; derive the real previous session close.
const dayKey = (unix, off) => new Date((unix + off) * 1000).toISOString().slice(0, 10);
async function snapshot(symbol) {
  return cached(`snap:${symbol}`, 15_000, async () => {
    const daily = await yahoo.raw(symbol, "1d", "5d");
    const c = daily.candles, m = daily.meta;
    const lastIsToday = c.length && m.marketTime && dayKey(c[c.length - 1].time, m.gmtoffset) === dayKey(m.marketTime, m.gmtoffset);
    m.prevClose = (lastIsToday ? c[c.length - 2] : c[c.length - 1])?.close ?? m.prevClose;
    m.market = marketOf(symbol);
    const now = Date.now() / 1000;
    m.marketOpen = m.market === "crypto" ? true : !!(m.session && now >= m.session.start && now < m.session.end);
    m.spark = c.slice(-5).map((x) => x.close);
    return m;
  });
}

// ---------------- API ----------------

async function chart(symbol, interval) {
  const sources = candidateSources(symbol, interval);
  const errors = [];
  let candles = null, used = null;
  for (const id of sources) {
    try {
      const ttl = interval.endsWith("m") ? 8_000 : 60_000;
      candles = await cached(`c:${id}:${symbol}:${interval}`, ttl, () => PROVIDERS[id].candles(symbol, interval, config.providers[id] || {}));
      if (!candles.length) throw new ProviderError("returned no candles", 404);
      used = PROVIDERS[id];
      break;
    } catch (err) {
      errors.push(`${PROVIDERS[id].name}: ${err.message}`);
    }
  }
  if (!used) throw new ProviderError(errors.join(" · ") || "No data source supports this symbol", 404);
  let meta;
  try { meta = await snapshot(symbol); } catch {
    const last = candles[candles.length - 1];
    meta = { symbol, name: symbol, exchange: "", currency: "", gmtoffset: 0, price: last.close, prevClose: candles[candles.length - 2]?.close, market: marketOf(symbol), marketOpen: false };
  }
  return {
    meta, candles,
    source: { id: used.id, name: used.name, live: !!used.live, stream: used.stream?.(symbol, interval) || null },
    fallback: errors.length ? errors : null,
  };
}

function providersView() {
  return {
    markets: MARKETS,
    routing: Object.fromEntries(Object.keys(MARKETS).map((m) => [m, config.routing[m] || "auto"])),
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, name: p.name, builtIn: !!p.builtIn, markets: p.markets, note: p.note, live: !!p.live,
      configured: isConfigured(p.id),
      fields: (p.fields || []).map((f) => ({ ...f, value: f.secret ? mask(config.providers[p.id]?.[f.key]) : config.providers[p.id]?.[f.key] || "" })),
    })),
  };
}

async function readBody(req, maxChars = 20_000) {
  let s = "";
  for await (const chunk of req) { s += chunk; if (s.length > maxChars) throw new ProviderError("Body too large", 413); }
  return s ? JSON.parse(s) : {};
}

async function handleApi(req, url) {
  const p = url.pathname;
  if (p === "/api/chart") {
    const symbol = url.searchParams.get("symbol") || "";
    const interval = url.searchParams.get("interval") || "1d";
    if (!SYMBOL_RE.test(symbol) || !INTERVALS.includes(interval)) throw new ProviderError("Bad symbol or interval", 400);
    return chart(symbol, interval);
  }
  if (p === "/api/quotes") {
    const symbols = (url.searchParams.get("symbols") || "").split(",").filter((s) => SYMBOL_RE.test(s)).slice(0, 80);
    const results = await Promise.allSettled(symbols.map((s) => snapshot(s)));
    return results.map((r, i) => (r.status === "fulfilled" ? r.value : { symbol: symbols[i], error: true }));
  }
  if (p === "/api/search") {
    const q = (url.searchParams.get("q") || "").slice(0, 60);
    if (!q.trim()) return [];
    const json = await cached(`s:${q}`, 300_000, async () => {
      const res = await fetch(`https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=20&newsCount=0&listsCount=0`, { headers: { "User-Agent": "Mozilla/5.0" } });
      return res.json();
    });
    return (json.quotes || [])
      .filter((x) => x.symbol && ["EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "CURRENCY", "FUTURE", "MUTUALFUND"].includes(x.quoteType))
      .map((x) => ({ symbol: x.symbol, name: x.longname || x.shortname || x.symbol, exchange: x.exchDisp, type: x.typeDisp || x.quoteType, market: marketOf(x.symbol) }));
  }
  if (p === "/api/screener/meta") return { markets: Object.fromEntries(Object.entries(SCREENER_MARKETS).map(([k, m]) => [k, { label: m.label, exchanges: m.exchanges, universes: m.universes || null, currency: m.currency, source: m.source || "Yahoo screener" }])), sectors: SECTORS };
  if (p === "/api/screener" && req.method === "POST") return runScreen(await readBody(req));
  if (p === "/api/perf") {
    const symbols = (url.searchParams.get("symbols") || "").split(",").filter((s) => SYMBOL_RE.test(s));
    return performance(symbols);
  }
  if (p === "/api/userdata" && req.method === "GET") return readUserData();
  if (p === "/api/userdata" && req.method === "POST") {
    const body = await readBody(req, 20_000_000);
    if (!body || typeof body.items !== "object" || !Number.isFinite(body.savedAt)) throw new ProviderError("Bad user data", 400);
    const items = Object.fromEntries(Object.entries(body.items).filter(([k, v]) => k.startsWith("bz:") && typeof v === "string"));
    writeUserData({ savedAt: body.savedAt, items });
    return { ok: true, keys: Object.keys(items).length, path: "data/userdata.json" };
  }
  if (p === "/api/providers" && req.method === "GET") return providersView();
  if (p === "/api/routing" && req.method === "POST") {
    const body = await readBody(req);
    for (const [m, id] of Object.entries(body)) {
      if (MARKETS[m] && (id === "auto" || PROVIDERS[id])) config.routing[m] = id;
    }
    saveConfig(config);
    cache.clear();
    return providersView();
  }
  const pm = /^\/api\/providers\/([a-z]+)(\/test)?$/.exec(p);
  if (pm && PROVIDERS[pm[1]] && !PROVIDERS[pm[1]].builtIn) {
    const prov = PROVIDERS[pm[1]];
    if (pm[2] && req.method === "POST") {
      if (!isConfigured(prov.id)) throw new ProviderError("Save the key first", 400);
      const started = Date.now();
      const candles = await prov.candles(prov.testSymbol, "1d", config.providers[prov.id]);
      return { ok: true, symbol: prov.testSymbol, candles: candles.length, ms: Date.now() - started };
    }
    if (req.method === "POST") {
      const body = await readBody(req);
      const next = { ...(config.providers[prov.id] || {}) };
      for (const f of prov.fields) {
        const v = typeof body[f.key] === "string" ? body[f.key].trim() : "";
        if (v && !v.startsWith("••••")) next[f.key] = v; // masked value = unchanged
      }
      config.providers[prov.id] = next;
      saveConfig(config);
      cache.clear();
      return providersView();
    }
    if (req.method === "DELETE") {
      delete config.providers[prov.id];
      for (const [m, id] of Object.entries(config.routing)) if (id === prov.id) config.routing[m] = "auto";
      saveConfig(config);
      cache.clear();
      return providersView();
    }
  }
  throw new ProviderError("Not found", 404);
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  if (url.pathname.startsWith("/api/")) {
    try {
      const data = await handleApi(req, url);
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify(data));
    } catch (err) {
      res.writeHead(err.status && err.status >= 400 && err.status < 600 ? err.status : 502, { "Content-Type": "application/json" })
        .end(JSON.stringify({ error: err.message }));
    }
    return;
  }
  if (url.pathname.startsWith("/data/")) { res.writeHead(404).end("not found"); return; } // never serve stored keys
  const file = path.join(root, url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname));
  if (!file.startsWith(root) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end("not found");
    return;
  }
  res.writeHead(200, { "Content-Type": types[path.extname(file)] || "application/octet-stream", "Cache-Control": "no-store" });
  fs.createReadStream(file).pipe(res);
}).on("error", (e) => {
  if (e.code !== "EADDRINUSE") throw e;
  // Probably LinkCharts is already running (e.g. started twice): just open it.
  console.log(`Port ${port} is already in use. If LinkCharts is already running, open http://localhost:${port}`);
  if (openBrowser) launchBrowser(`http://localhost:${port}`);
}).listen(port, "127.0.0.1", () => {
  console.log(`LinkCharts running at http://localhost:${port}`);
  console.log("Keep this window open while you use LinkCharts. Close it (or press Ctrl+C) to stop.");
  if (openBrowser) launchBrowser(`http://localhost:${port}`);
});
