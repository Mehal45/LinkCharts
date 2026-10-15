// LinkCharts: wires the chart, drawings, replay, watchlists, alerts, paper trading and data feeds together.
import { $, api, esc, store, uid, bus, short, toast, modal } from "./util.js";
import { INDICATORS, paramLabel, shortLabel } from "./indicators.js";
import { ChartView } from "./chart.js";
import { Drawings, TOOLS } from "./drawings.js";
import { Replay } from "./replay.js";
import { Watchlists } from "./watchlists.js";
import { Alerts } from "./alerts.js";
import { Trading } from "./trading.js";
import { Details } from "./details.js";
import { Screener } from "./screener.js";
import { applyTheme, currentTheme, openThemePicker } from "./themes.js";
import { openSettings } from "./settings.js";

const INTERVALS = [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["30m", "30m"], ["60m", "1H"], ["1d", "1D"], ["1wk", "1W"], ["1mo", "1M"]];
const TYPES = [["candles", "🕯", "Candles"], ["hollow", "◫", "Hollow candles"], ["bars", "┤", "Bars"], ["line", "〜", "Line"], ["area", "◭", "Area"]];
const ALIASES = [
  { match: "zomato", symbol: "ETERNAL.NS", name: "Eternal Limited (formerly Zomato)" },
  { match: "bitcoin", symbol: "BTC-USD", name: "Bitcoin USD" },
  { match: "ethereum", symbol: "ETH-USD", name: "Ethereum USD" },
  { match: "gold", symbol: "GC=F", name: "Gold futures" },
  { match: "nifty", symbol: "^NSEI", name: "NIFTY 50" },
  { match: "sensex", symbol: "^BSESN", name: "S&P BSE SENSEX" },
  { match: "s&p", symbol: "^GSPC", name: "S&P 500" },
];

// ---------------- state ----------------

const state = {
  symbol: store.get("symbol", "^NSEI"),
  interval: store.get("interval", "1d"),
  type: store.get("type", "candles"),
  studies: store.get("studies", [{ id: uid(), type: "sma", params: { period: 50 } }]), // volume is opt-in via ƒx Indicators
  meta: null,
  source: null,
  quotes: {},
  sidebar: store.get("sidebar", "watchlist"),
};
const persist = () => {
  store.set("symbol", state.symbol); store.set("interval", state.interval); store.set("type", state.type);
  store.set("studies", state.studies); store.set("sidebar", state.sidebar);
};
const isIntraday = () => /m$/.test(state.interval);

// ---------------- components ----------------

const view = new ChartView({ charts: $("charts"), mainPane: $("mainPane"), legend: $("legend") });
bus.on("theme", (t) => view.applyTheme(t.chart));
applyTheme(currentTheme().id); // restore the saved theme before anything is drawn
view.type = state.type;
view.setType(state.type);
view.setStudies(state.studies);

const drawings = new Drawings(view, { toolbar: $("drawTools"), floating: $("floatBar") });

const replay = new Replay({ view, bar: $("replayBar"), onExit: () => loadChart() });

const getPrice = (symbol) => {
  if (replay.active && symbol === state.symbol) return replay.currentBar?.close ?? null;
  if (symbol === state.symbol && view.candles.length) return view.candles[view.candles.length - 1].close;
  return state.quotes[symbol]?.price ?? null;
};
const getMeta = (symbol) => (symbol === state.symbol ? state.meta : state.quotes[symbol]);

const watchlists = new Watchlists({ el: $("watchPanel"), onSelect: (s) => selectSymbol(s) });
const alerts = new Alerts({ el: $("alertsPanel"), view, getPrice, getSymbol: () => state.symbol });
const trading = new Trading({ el: $("bottomPanel"), view, getPrice, getMeta, isReplay: () => replay.active });
const details = new Details({ el: $("details"), onTrade: (s, side) => trading.openTicket(s, side) });
const screener = new Screener({
  el: $("screenerView"),
  onOpenSymbol: (s) => { screener.close(); selectSymbol(s); },
  onAddToWatchlist: (symbols) => watchlists.addSymbols(symbols),
});

bus.on("open-symbol", (s) => selectSymbol(s));
bus.on("remove-study", (id) => { state.studies = state.studies.filter((s) => s.id !== id); view.setStudies(state.studies); persist(); });
bus.on("watch-symbols", () => loadQuotes());
bus.on("sources-changed", () => loadChart());
bus.on("replay-mode", (mode) => {
  document.body.classList.toggle("in-replay", mode === "active");
  renderHeader();
  if (mode === "active") closeStream();
});

// ---------------- header / toolbar ----------------

function renderHeader() {
  $("intervals").innerHTML = INTERVALS.map(([k, l]) => `<button data-iv="${k}" class="${k === state.interval ? "on" : ""}">${l}</button>`).join("");
  $("types").innerHTML = TYPES.map(([k, icon, l]) => `<button data-ty="${k}" class="${k === state.type ? "on" : ""}" title="${l}">${icon}</button>`).join("");
  $("replayBtn").classList.toggle("on", replay.state !== "off");
  $("symbolBtn").textContent = short(state.symbol);
  const src = state.source;
  $("sourceBadge").innerHTML = src
    ? `<span class="pill ${src.live && !replay.active ? "live" : ""}" title="${esc(state.fallback ? "Fell back: " + state.fallback.join(" · ") : "Data source")}">${src.live && !replay.active ? "● LIVE · " : ""}${esc(src.name)}${state.fallback ? " ⚠" : ""}</span>`
    : "";
  const m = state.meta;
  $("mstatus").innerHTML = m ? `<i class="mk ${m.marketOpen ? "open" : ""}"></i>${m.market === "crypto" ? "24/7" : m.marketOpen ? "Market open" : "Market closed"}` : "";
}

$("intervals").onclick = (e) => {
  const iv = e.target.closest("[data-iv]")?.dataset.iv;
  if (!iv || iv === state.interval) return;
  state.interval = iv; persist(); renderHeader(); loadChart({ reset: true });
};
$("types").onclick = (e) => {
  const ty = e.target.closest("[data-ty]")?.dataset.ty;
  if (!ty) return;
  state.type = ty; persist(); renderHeader(); view.setType(ty);
};
$("replayBtn").onclick = () => (replay.state === "off" ? replay.start() : replay.exit());
$("alertBtn").onclick = () => alerts.openDialog();
$("tradeBtn").onclick = () => trading.openTicket(state.symbol, "buy");
$("settingsBtn").onclick = () => openSettings();
$("screenerBtn").onclick = () => (screener.el.hidden ? screener.open() : screener.close());
$("themeBtn").onclick = () => openThemePicker();
$("indBtn").onclick = () => openIndicatorPicker();
$("fitBtn").onclick = () => view.fit();
$("symbolBtn").onclick = () => $("search").focus();

$("legend").addEventListener("click", (e) => {
  const rm = e.target.dataset.remove, ed = e.target.dataset.edit;
  if (rm) bus.emit("remove-study", rm);
  if (ed) editStudy(ed);
});

// ---------------- indicators ----------------

function addStudy(type) {
  const def = INDICATORS[type];
  if (type === "vol" && state.studies.some((s) => s.type === "vol")) return toast("Volume is already on the chart");
  state.studies.push({ id: uid(), type, params: { ...def.params } });
  view.setStudies(state.studies);
  persist();
  toast(`Added ${def.label}`);
}

function openIndicatorPicker() {
  const groups = {};
  for (const [id, d] of Object.entries(INDICATORS)) (groups[d.group] ??= []).push([id, d]);
  const m = modal("Indicators", `
    <input id="ind-q" class="wide-input" placeholder="Search indicators…" autocomplete="off" />
    <div id="ind-list">${Object.entries(groups).map(([g, list]) => `<div class="ind-group"><div class="muted small">${g}</div>
      ${list.map(([id, d]) => `<button class="ind-item" data-ind="${id}" data-name="${esc(d.label.toLowerCase())}">${esc(d.label)}<span class="muted small">${d.kind === "pane" ? "separate pane" : d.kind === "volume" ? "volume" : "on chart"}</span></button>`).join("")}</div>`).join("")}</div>
    <div class="muted small">On chart now: ${state.studies.map((s) => esc(shortLabel(s.type, s.params))).join(", ") || "none"} — click ⚙ in the chart legend or a pane label to change settings.</div>`);
  const q = m.el.querySelector("#ind-q");
  q.focus();
  q.oninput = () => m.el.querySelectorAll(".ind-item").forEach((b) => (b.hidden = !b.dataset.name.includes(q.value.toLowerCase())));
  m.el.querySelector("#ind-list").onclick = (e) => { const id = e.target.closest("[data-ind]")?.dataset.ind; if (id) addStudy(id); };
}

function editStudy(id) {
  const s = state.studies.find((x) => x.id === id);
  if (!s) return;
  const def = INDICATORS[s.type];
  const keys = Object.keys(def.params);
  if (!keys.length) return toast(`${def.label} has no settings`);
  const m = modal(`${def.label} settings`, `${keys.map((k) => `<label class="field"><span>${paramLabel(k)}</span><input type="number" step="any" min="0" data-k="${k}" value="${s.params[k]}" /></label>`).join("")}
    <div class="row-end"><button data-close>Cancel</button><button class="primary" id="st-ok">Apply</button></div>`);
  m.el.querySelector("[data-close]").onclick = m.close;
  m.el.querySelector("#st-ok").onclick = () => {
    m.el.querySelectorAll("[data-k]").forEach((i) => { const v = parseFloat(i.value); if (v > 0) s.params[i.dataset.k] = v; });
    view.setStudies(state.studies);
    persist();
    m.close();
  };
}
$("charts").addEventListener("click", (e) => {
  const label = e.target.closest(".pane-label");
  if (!label) return;
  const pane = [...view.panes.entries()].find(([, p]) => p.el.contains(label));
  if (pane) editStudy(pane[0]);
});

// ---------------- data loading ----------------

let loadToken = 0;

async function loadChart({ reset = false } = {}) {
  const token = ++loadToken;
  $("loading").hidden = false;
  $("error").hidden = true;
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}`);
    if (token !== loadToken) return;
    const off = data.meta.gmtoffset ?? 0; // show the exchange's local time on the axis
    const candles = dedupe(data.candles.map((c) => ({ ...c, time: c.time + off })));
    state.meta = data.meta;
    state.source = data.source;
    state.fallback = data.fallback;
    state.offset = off;
    view.intraday = isIntraday();
    if (replay.active && replay.reload(candles)) { /* replay keeps its own cut */ }
    else {
      view.setData(candles, data.meta);
      openStream();
    }
    drawings.redraw();
    alerts.drawLines();
    trading.drawLines();
    trading.render();
    details.update(data.meta, replay.active ? null : candles[candles.length - 1]?.close);
    watchlists.setCurrent(state.symbol);
    renderHeader();
    $("loading").hidden = true;
    $("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
    if (reset) view.showTail();
  } catch (err) {
    if (token !== loadToken) return;
    $("loading").hidden = true;
    $("error").hidden = false;
    $("error").textContent = err.message;
  }
}

function dedupe(candles) {
  const out = [];
  for (const c of candles) {
    if (out.length && out[out.length - 1].time >= c.time) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}

/** Periodic refresh for non-streaming sources (keeps zoom; only merges new/changed bars). */
async function refreshChart() {
  if (replay.state !== "off" || state.source?.stream) return;
  try {
    const data = await api(`/api/chart?symbol=${encodeURIComponent(state.symbol)}&interval=${state.interval}`);
    if (data.meta.symbol !== state.symbol) return;
    const off = data.meta.gmtoffset ?? 0;
    view.mergeTail(dedupe(data.candles.map((c) => ({ ...c, time: c.time + off }))));
    state.meta = data.meta;
    afterLiveUpdate();
  } catch { /* keep showing the last good data */ }
}

function afterLiveUpdate() {
  const last = view.candles[view.candles.length - 1];
  if (!last) return;
  bus.emit("live-price", { symbol: state.symbol, price: last.close, high: last.close, low: last.close });
  details.update(state.meta, last.close);
  trading.render();
  $("updated").textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

// Binance kline stream: true real-time candles for crypto.
let ws = null;
function closeStream() { if (ws) { ws.onclose = null; ws.close(); ws = null; } }
function openStream() {
  closeStream();
  const url = state.source?.stream;
  if (!url || replay.state !== "off") return;
  const sym = state.symbol;
  ws = new WebSocket(url);
  ws.onmessage = (ev) => {
    const k = JSON.parse(ev.data).k;
    if (!k || sym !== state.symbol || replay.state !== "off") return;
    const bar = { time: Math.floor(k.t / 1000) + (state.offset || 0), open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v };
    view.mergeTail([bar]);
    afterLiveUpdate();
  };
  ws.onclose = () => { if (sym === state.symbol && replay.state === "off") setTimeout(openStream, 3000); };
}

// ---------------- quotes (watchlist, alerts, positions) ----------------

async function loadQuotes() {
  const symbols = [...new Set([...watchlists.symbols(), ...alerts.symbols(), ...trading.symbols(), state.symbol])];
  if (!symbols.length) return;
  try {
    const list = await api(`/api/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    for (const q of list) if (!q.error) state.quotes[q.symbol] = q;
    bus.emit("quotes", state.quotes);
    if (!replay.active) trading.render();
  } catch { /* keep last quotes */ }
}

// ---------------- symbol selection & search ----------------

function selectSymbol(sym) {
  if (sym === state.symbol) return;
  if (replay.state !== "off") replay.exit();
  state.symbol = sym;
  state.meta = null;
  persist();
  drawings.setSymbol(sym);
  watchlists.setCurrent(sym);
  renderHeader();
  loadChart({ reset: true });
}

let searchTimer, results = [], active = -1;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  const q = e.target.value.trim();
  if (!q) { $("results").hidden = true; return; }
  searchTimer = setTimeout(async () => {
    try {
      const found = await api(`/api/search?q=${encodeURIComponent(q)}`);
      const lq = q.toLowerCase();
      const alias = ALIASES.filter((a) => a.match.startsWith(lq) || lq.startsWith(a.match)).map((a) => ({ symbol: a.symbol, name: a.name, exchange: "", type: "" }));
      const seen = new Set();
      results = [...alias, ...found].filter((r) => !seen.has(r.symbol) && seen.add(r.symbol));
      // Let people type an exact Yahoo symbol too (e.g. "TCS.NS", "BTC-USD").
      if (/^[\^A-Z0-9.\-=]{2,}$/i.test(q) && !seen.has(q.toUpperCase())) results.push({ symbol: q.toUpperCase(), name: "Open this exact symbol", exchange: "", type: "" });
      active = results.length ? 0 : -1;
      renderResults();
    } catch { /* ignore */ }
  }, 220);
});
$("search").addEventListener("keydown", (e) => {
  if ($("results").hidden) return;
  if (e.key === "ArrowDown") { active = Math.min(results.length - 1, active + 1); renderResults(); e.preventDefault(); }
  if (e.key === "ArrowUp") { active = Math.max(0, active - 1); renderResults(); e.preventDefault(); }
  if (e.key === "Enter" && results[active]) pickResult(results[active]);
  if (e.key === "Escape") { $("results").hidden = true; e.target.blur(); }
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".search")) $("results").hidden = true;
  if (!e.target.closest(".menu")) document.querySelectorAll(".menu-pop").forEach((p) => (p.hidden = true));
});
function renderResults() {
  const box = $("results");
  box.hidden = false;
  box.innerHTML = results.length
    ? results.map((r, i) => `<div class="${i === active ? "active" : ""}" data-i="${i}"><b>${esc(short(r.symbol))}</b><em>${esc([r.type, r.exchange].filter(Boolean).join(" · "))}</em><small>${esc(r.name)} <span class="muted">${esc(r.symbol)}</span></small></div>`).join("")
    : `<div><small>No matches</small></div>`;
  box.querySelectorAll("[data-i]").forEach((el) => (el.onclick = () => pickResult(results[+el.dataset.i])));
}
function pickResult(r) {
  $("results").hidden = true;
  $("search").value = "";
  $("search").blur();
  selectSymbol(r.symbol);
}

// ---------------- right sidebar tabs ----------------

function renderSidebar() {
  document.querySelectorAll("[data-side]").forEach((b) => b.classList.toggle("on", b.dataset.side === state.sidebar));
  $("watchPanel").hidden = state.sidebar !== "watchlist";
  $("alertsPanel").hidden = state.sidebar !== "alerts";
}
$("sideTabs").onclick = (e) => {
  const s = e.target.closest("[data-side]")?.dataset.side;
  if (!s) return;
  state.sidebar = s; persist(); renderSidebar();
};

// ---------------- keyboard shortcuts ----------------

document.addEventListener("keydown", (e) => {
  if (e.target.closest("input, textarea, select")) return;
  if (e.key === "Escape") {
    if (!screener.el.hidden) { screener.close(); return; }
    drawings.cancel(); if (replay.state === "picking") replay.exit(); return;
  }
  if (!screener.el.hidden) return; // chart shortcuts are off while the screener is open
  if ((e.key === "Delete" || e.key === "Backspace") && drawings.deleteSelected()) { e.preventDefault(); return; }
  if (e.shiftKey && e.key === "ArrowRight" && replay.active) { e.preventDefault(); replay.step(); return; }
  if (e.shiftKey && e.code === "Space" && replay.active) { e.preventDefault(); replay.toggle(); return; }
  if (e.altKey) {
    const key = e.key.toLowerCase();
    const tool = TOOLS.find((t) => t.key && t.key.toLowerCase() === `alt+${e.shiftKey ? "shift+" : ""}${key}`);
    if (tool) { e.preventDefault(); drawings.setTool(tool.id); return; }
    if (key === "a") { e.preventDefault(); alerts.openDialog(); return; }
    if (key === "r" && !e.shiftKey) { e.preventDefault(); $("replayBtn").click(); return; }
  }
  // Start typing anywhere to search, like TradingView.
  if (/^[a-z0-9^]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) $("search").focus();
});

// ---------------- boot ----------------

// Theme picker greets people when the site opens (they can turn this off inside the picker).
if (store.get("theme-popup", true)) setTimeout(() => openThemePicker({ startup: true }), 400);
renderHeader();
renderSidebar();
drawings.setSymbol(state.symbol);
loadChart({ reset: true });
loadQuotes();
setInterval(loadQuotes, 15000);
setInterval(() => { if (isIntraday() || state.meta?.marketOpen) refreshChart(); }, 10000);
