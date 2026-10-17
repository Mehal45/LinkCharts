// LinkCharts: wires the charts (one or several, in a layout), drawings, replay, watchlists, alerts,
// paper trading and data feeds together. Shared panels always follow the *active* chart.
import { $, api, esc, store, uid, bus, short, toast, modal } from "./util.js";
import { INDICATORS, paramLabel, shortLabel } from "./indicators.js";
import { ChartView } from "./chart.js";
import { Drawings, TOOLS, renderDrawToolbar } from "./drawings.js";
import { Replay } from "./replay.js";
import { Watchlists } from "./watchlists.js";
import { Alerts } from "./alerts.js";
import { Trading } from "./trading.js";
import { Details } from "./details.js";
import { Screener } from "./screener.js";
import { applyTheme, currentTheme, openThemePicker } from "./themes.js";
import { openSettings } from "./settings.js";

const INTERVALS = [["1m", "1m"], ["5m", "5m"], ["15m", "15m"], ["30m", "30m"], ["60m", "1H"], ["1d", "1D"], ["1wk", "1W"], ["1mo", "1M"]];
const ivLabel = (iv) => INTERVALS.find(([k]) => k === iv)?.[1] || iv;
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

// Grid layouts. `areas` (optional) gives uneven layouts like one big chart + two small ones.
const LAYOUTS = [
  { id: "1", n: 1, label: "Single chart", cols: "1fr", rows: "1fr" },
  { id: "2v", n: 2, label: "2 side by side", cols: "1fr 1fr", rows: "1fr" },
  { id: "2h", n: 2, label: "2 stacked", cols: "1fr", rows: "1fr 1fr" },
  { id: "3v", n: 3, label: "3 in a row", cols: "1fr 1fr 1fr", rows: "1fr" },
  { id: "1+2", n: 3, label: "1 big + 2", cols: "2fr 1fr", rows: "1fr 1fr", areas: ["a b", "a c"] },
  { id: "3h", n: 3, label: "3 stacked", cols: "1fr", rows: "1fr 1fr 1fr" },
  { id: "2x2", n: 4, label: "2 × 2 grid", cols: "1fr 1fr", rows: "1fr 1fr" },
  { id: "1+3", n: 4, label: "1 big + 3 below", cols: "1fr 1fr 1fr", rows: "2fr 1fr", areas: ["a a a", "b c d"] },
  { id: "3x2", n: 6, label: "3 × 2 grid", cols: "1fr 1fr 1fr", rows: "1fr 1fr" },
  { id: "4x2", n: 8, label: "4 × 2 grid", cols: "repeat(4, 1fr)", rows: "1fr 1fr" },
];
const AREA_NAMES = "abcdefgh";

// ---------------- persisted state ----------------

// Older single-chart settings become chart #1.
const legacy = { symbol: store.get("symbol", "^NSEI"), interval: store.get("interval", "1d"), type: store.get("type", "candles"), studies: store.get("studies", [{ id: uid(), type: "sma", params: { period: 50 } }]) };
const state = {
  layout: store.get("layout", "1"),
  configs: store.get("slotConfigs", [legacy]), // one entry per chart position (kept even when the layout shrinks)
  activeIndex: store.get("activeSlot", 0),
  sync: store.get("layoutSync", { symbol: false, interval: false, crosshair: true }),
  quotes: {},
  sidebar: store.get("sidebar", "watchlist"),
};
const slots = [];
const active = () => slots[state.activeIndex] || slots[0];
const views = () => slots.map((s) => s.view);

function persist() {
  slots.forEach((s, i) => (state.configs[i] = s.config()));
  store.set("slotConfigs", state.configs);
  store.set("layout", state.layout);
  store.set("activeSlot", state.activeIndex);
  store.set("layoutSync", state.sync);
  store.set("sidebar", state.sidebar);
}

// Restore the saved theme before any chart is drawn.
applyTheme(currentTheme().id);

// ---------------- shared panels ----------------

const getPrice = (symbol) => {
  const a = active();
  if (a?.replay.active && symbol === a.symbol) return a.replay.currentBar?.close ?? null;
  const live = slots.find((s) => s.symbol === symbol && !s.replay.active && s.view.candles.length);
  if (live) return live.view.candles[live.view.candles.length - 1].close;
  return state.quotes[symbol]?.price ?? null;
};
const getMeta = (symbol) => slots.find((s) => s.symbol === symbol && s.meta)?.meta || state.quotes[symbol];

const watchlists = new Watchlists({ el: $("watchPanel"), onSelect: (s) => selectSymbol(s) });
const alerts = new Alerts({ el: $("alertsPanel"), getViews: views, getPrice, getSymbol: () => active().symbol });
const trading = new Trading({ el: $("bottomPanel"), getViews: views, getPrice, getMeta, isReplay: () => !!active()?.replay.active });
const details = new Details({ el: $("details"), onTrade: (s, side) => trading.openTicket(s, side) });
const screener = new Screener({
  el: $("screenerView"),
  onOpenSymbol: (s) => { screener.close(); selectSymbol(s); },
  onAddToWatchlist: (symbols) => watchlists.addSymbols(symbols),
});

// ---------------- chart slot ----------------

class Slot {
  constructor(cfg) {
    this.symbol = cfg.symbol;
    this.interval = cfg.interval;
    this.type = cfg.type || "candles";
    this.studies = cfg.studies || [];
    this.meta = null;
    this.source = null;
    this.fallback = null;
    this.offset = 0;
    this.loadToken = 0;
    this.ws = null;
    this.updatedAt = null;

    this.el = document.createElement("div");
    this.el.className = "slot";
    this.el.innerHTML = `
      <div class="charts"><div class="pane main">
        <div class="legend"></div><div class="float-bar" hidden></div>
        <div class="loading">Loading…</div><div class="error" hidden></div>
      </div></div>
      <div class="slot-tag"></div>
      <div class="replay-bar" hidden></div>`;
    $("slots").appendChild(this.el);
    const q = (sel) => this.el.querySelector(sel);
    this.mainPane = q(".pane.main");
    this.legendEl = q(".legend");
    this.loadingEl = q(".loading");
    this.errorEl = q(".error");
    this.tagEl = q(".slot-tag");

    this.view = new ChartView({ charts: q(".charts"), mainPane: this.mainPane, legend: this.legendEl });
    this.view.applyTheme(currentTheme().chart);
    this.view.type = this.type;
    this.view.setType(this.type);
    this.view.setStudies(this.studies);
    this.drawings = new Drawings(this.view, { floating: q(".float-bar"), onToolChange: () => { if (this === active()) renderTools(); } });
    this.drawings.setSymbol(this.symbol);
    this.replay = new Replay({ view: this.view, bar: q(".replay-bar"), onExit: () => this.load() });

    // Clicking anywhere in a chart makes it the active one (without stealing the click).
    this.el.addEventListener("pointerdown", () => setActive(slots.indexOf(this)), true);
    this.el.addEventListener("pointerenter", () => (hoverSlot = this));
    this.el.addEventListener("pointerleave", () => { if (hoverSlot === this) { hoverSlot = null; clearSyncedCrosshairs(); } });
    this.legendEl.addEventListener("click", (e) => {
      if (e.target.dataset.remove) removeStudy(this, e.target.dataset.remove);
      if (e.target.dataset.edit) editStudy(this, e.target.dataset.edit);
    });
    q(".charts").addEventListener("click", (e) => {
      const label = e.target.closest(".pane-label");
      if (!label) return;
      const pane = [...this.view.panes.entries()].find(([, p]) => p.el.contains(label));
      if (pane) editStudy(this, pane[0]);
    });
  }

  config() { return { symbol: this.symbol, interval: this.interval, type: this.type, studies: this.studies }; }
  isIntraday() { return /m$/.test(this.interval); }
  isActive() { return this === active(); }

  async load({ reset = false } = {}) {
    const token = ++this.loadToken;
    this.loadingEl.hidden = false;
    this.errorEl.hidden = true;
    this.tagEl.textContent = ivLabel(this.interval);
    try {
      const data = await api(`/api/chart?symbol=${encodeURIComponent(this.symbol)}&interval=${this.interval}`);
      if (token !== this.loadToken) return;
      const off = data.meta.gmtoffset ?? 0; // show the exchange's local time on the axis
      const candles = dedupe(data.candles.map((c) => ({ ...c, time: c.time + off })));
      Object.assign(this, { meta: data.meta, source: data.source, fallback: data.fallback, offset: off });
      this.view.offset = off;
      this.view.intraday = this.isIntraday();
      if (!(this.replay.active && this.replay.reload(candles))) {
        this.view.setData(candles, data.meta);
        this.openStream();
      }
      this.drawings.redraw();
      alerts.drawLines();
      trading.drawLines();
      this.updatedAt = new Date();
      this.loadingEl.hidden = true;
      if (reset) this.view.showTail();
      if (this.isActive()) syncPanels();
    } catch (err) {
      if (token !== this.loadToken) return;
      this.loadingEl.hidden = true;
      this.errorEl.hidden = false;
      this.errorEl.textContent = err.message;
    }
  }

  /** Periodic refresh for non-streaming sources (keeps zoom; only merges new/changed bars). */
  async refresh() {
    if (this.replay.state !== "off" || this.source?.stream || !this.meta) return;
    if (!(this.isIntraday() || this.meta.marketOpen)) return;
    try {
      const data = await api(`/api/chart?symbol=${encodeURIComponent(this.symbol)}&interval=${this.interval}`);
      if (data.meta.symbol !== this.symbol) return;
      this.view.mergeTail(dedupe(data.candles.map((c) => ({ ...c, time: c.time + (data.meta.gmtoffset ?? 0) }))));
      this.meta = data.meta;
      this.afterLiveUpdate();
    } catch { /* keep showing the last good data */ }
  }

  afterLiveUpdate() {
    const last = this.view.candles[this.view.candles.length - 1];
    if (!last) return;
    this.updatedAt = new Date();
    bus.emit("live-price", { symbol: this.symbol, price: last.close, high: last.close, low: last.close });
    if (this.isActive()) {
      details.update(this.meta, last.close);
      trading.render();
      $("updated").textContent = `Updated ${this.updatedAt.toLocaleTimeString()}`;
    }
  }

  // Binance kline stream: true real-time candles for crypto.
  closeStream() { if (this.ws) { this.ws.onclose = null; this.ws.close(); this.ws = null; } }
  openStream() {
    this.closeStream();
    const url = this.source?.stream;
    if (!url || this.replay.state !== "off") return;
    const sym = this.symbol;
    this.ws = new WebSocket(url);
    this.ws.onmessage = (ev) => {
      const k = JSON.parse(ev.data).k;
      if (!k || sym !== this.symbol || this.replay.state !== "off") return;
      this.view.mergeTail([{ time: Math.floor(k.t / 1000) + this.offset, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v }]);
      this.afterLiveUpdate();
    };
    this.ws.onclose = () => { if (sym === this.symbol && this.replay.state === "off" && slots.includes(this)) setTimeout(() => this.openStream(), 3000); };
  }

  setSymbol(sym) {
    if (sym === this.symbol) return;
    if (this.replay.state !== "off") this.replay.exit();
    this.symbol = sym;
    this.meta = null;
    this.drawings.setSymbol(sym);
    this.load({ reset: true });
  }

  setInterval(iv) {
    if (iv === this.interval) return;
    this.interval = iv;
    this.load({ reset: true });
  }

  dispose() {
    this.closeStream();
    this.replay.pause();
    this.drawings.dispose();
    this.view.dispose();
    this.el.remove();
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

// ---------------- layouts ----------------

/** A sensible symbol for a newly opened chart: the next watchlist symbol not already on screen. */
function nextSymbol() {
  const open = new Set(slots.map((s) => s.symbol));
  return watchlists.symbols().find((s) => !open.has(s)) || active()?.symbol || "^NSEI";
}

function setLayout(id) {
  const layout = LAYOUTS.find((l) => l.id === id) || LAYOUTS[0];
  persist(); // remember the configs of charts that are about to close
  state.layout = layout.id;
  while (slots.length > layout.n) slots.pop().dispose();
  while (slots.length < layout.n) {
    const i = slots.length;
    const cfg = state.configs[i] || { symbol: nextSymbol(), interval: active()?.interval || "1d", type: "candles", studies: [] };
    const slot = new Slot(cfg);
    slots.push(slot);
    slot.load({ reset: true });
  }
  const grid = $("slots");
  grid.style.gridTemplateColumns = layout.cols;
  grid.style.gridTemplateRows = layout.rows;
  grid.style.gridTemplateAreas = layout.areas ? layout.areas.map((r) => `"${r}"`).join(" ") : "";
  slots.forEach((s, i) => (s.el.style.gridArea = layout.areas ? AREA_NAMES[i] : ""));
  grid.classList.toggle("multi", layout.n > 1);
  if (state.activeIndex >= slots.length) state.activeIndex = 0;
  setActive(state.activeIndex, { force: true });
  persist();
  renderLayoutMenu();
  loadQuotes();
}

function setActive(i, { force = false } = {}) {
  if (i < 0 || (!force && i === state.activeIndex)) return;
  const prev = slots[state.activeIndex];
  if (prev && prev !== slots[i] && prev.drawings.tool !== "cursor") prev.drawings.setTool("cursor");
  state.activeIndex = i;
  slots.forEach((s, j) => s.el.classList.toggle("active", j === i));
  store.set("activeSlot", i);
  syncPanels();
}

/** Points the header, toolbar, watchlist, details and trading panel at the active chart. */
function syncPanels() {
  const a = active();
  if (!a) return;
  renderHeader();
  renderTools();
  watchlists.setCurrent(a.symbol);
  if (a.meta) details.update(a.meta, a.replay.active ? null : a.view.candles[a.view.candles.length - 1]?.close);
  trading.render();
  trading.drawLines();
  $("updated").textContent = a.updatedAt ? `Updated ${a.updatedAt.toLocaleTimeString()}` : "";
  document.body.classList.toggle("in-replay", a.replay.active);
}

function layoutIcon(l) {
  const cells = Array.from({ length: l.n }, (_, i) => `<i style="${l.areas ? `grid-area:${AREA_NAMES[i]}` : ""}"></i>`).join("");
  return `<div class="layout-opt ${l.id === state.layout ? "on" : ""}" data-layout="${l.id}" title="${esc(l.label)}"
    style="grid-template-columns:${l.cols};grid-template-rows:${l.rows};${l.areas ? `grid-template-areas:${l.areas.map((r) => `'${r}'`).join(" ")}` : ""}">${cells}</div>`;
}

function renderLayoutMenu() {
  const pop = $("layoutPop");
  pop.innerHTML = `<div class="muted small" style="margin-bottom:8px">Chart layout — click a chart to make it active</div>
    <div class="layout-grid">${LAYOUTS.map(layoutIcon).join("")}</div>
    <div class="layout-sync">
      <b class="small">Sync across charts</b>
      <label><input type="checkbox" data-sync="symbol" ${state.sync.symbol ? "checked" : ""}/> Symbol</label>
      <label><input type="checkbox" data-sync="interval" ${state.sync.interval ? "checked" : ""}/> Interval</label>
      <label><input type="checkbox" data-sync="crosshair" ${state.sync.crosshair ? "checked" : ""}/> Crosshair (same moment in time)</label>
    </div>`;
  const n = LAYOUTS.find((l) => l.id === state.layout)?.n || 1;
  $("layoutBtn").textContent = n > 1 ? `⊞ ${n} charts` : "⊞ Layout";
}
$("layoutBtn").onclick = (e) => { e.stopPropagation(); $("layoutPop").hidden = !$("layoutPop").hidden; };
$("layoutPop").onclick = (e) => {
  e.stopPropagation();
  const id = e.target.closest("[data-layout]")?.dataset.layout;
  if (id) setLayout(id);
};
$("layoutPop").onchange = (e) => {
  const k = e.target.dataset.sync;
  if (!k) return;
  state.sync[k] = e.target.checked;
  persist();
  if (k === "symbol" && e.target.checked) slots.forEach((s) => s.setSymbol(active().symbol));
  if (k === "interval" && e.target.checked) slots.forEach((s) => s.setInterval(active().interval));
};

// ---------------- crosshair sync ----------------

let hoverSlot = null;
function clearSyncedCrosshairs() {
  if (!state.sync.crosshair) return;
  for (const s of slots) if (s !== hoverSlot) try { s.view.chart.clearCrosshairPosition(); } catch { /* chart closing */ }
}
bus.on("crosshair", ({ time, view }) => {
  if (!state.sync.crosshair || slots.length < 2 || !hoverSlot || view !== hoverSlot.view) return; // only mirror the chart under the mouse
  if (time == null) return clearSyncedCrosshairs();
  const realTime = time - hoverSlot.offset;
  for (const s of slots) {
    if (s === hoverSlot || !s.view.candles.length) continue;
    // Same moment in real time → that chart's bar at or before it.
    const target = realTime + s.offset;
    const c = s.view.candles;
    let lo = 0, hi = c.length - 1, idx = -1;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (c[mid].time <= target) { idx = mid; lo = mid + 1; } else hi = mid - 1; }
    if (idx < 0) { s.view.chart.clearCrosshairPosition(); continue; }
    try { s.view.chart.setCrosshairPosition(c[idx].close, c[idx].time, s.view.price); } catch { /* chart not ready */ }
  }
});

// ---------------- events from panels ----------------

bus.on("theme", (t) => slots.forEach((s) => s.view.applyTheme(t.chart)));
bus.on("open-symbol", (s) => selectSymbol(s));
bus.on("remove-study", (id) => { const slot = slots.find((s) => s.studies.some((x) => x.id === id)); if (slot) removeStudy(slot, id); });
bus.on("watch-symbols", () => loadQuotes());
bus.on("sources-changed", () => slots.forEach((s) => s.load()));
bus.on("replay-mode", () => {
  slots.forEach((s) => { if (s.replay.active) s.closeStream(); });
  document.body.classList.toggle("in-replay", !!active()?.replay.active);
  renderHeader();
});

// ---------------- header / toolbar ----------------

function renderHeader() {
  const a = active();
  if (!a) return;
  $("intervals").innerHTML = INTERVALS.map(([k, l]) => `<button data-iv="${k}" class="${k === a.interval ? "on" : ""}">${l}</button>`).join("");
  $("types").innerHTML = TYPES.map(([k, icon, l]) => `<button data-ty="${k}" class="${k === a.type ? "on" : ""}" title="${l}">${icon}</button>`).join("");
  $("replayBtn").classList.toggle("on", a.replay.state !== "off");
  $("symbolBtn").textContent = short(a.symbol);
  const src = a.source;
  $("sourceBadge").innerHTML = src
    ? `<span class="pill ${src.live && !a.replay.active ? "live" : ""}" title="${esc(a.fallback ? "Fell back: " + a.fallback.join(" · ") : "Data source")}">${src.live && !a.replay.active ? "● LIVE · " : ""}${esc(src.name)}${a.fallback ? " ⚠" : ""}</span>`
    : "";
  const m = a.meta;
  $("mstatus").innerHTML = m ? `<i class="mk ${m.marketOpen ? "open" : ""}"></i>${m.market === "crypto" ? "24/7" : m.marketOpen ? "Market open" : "Market closed"}` : "";
}
const renderTools = () => renderDrawToolbar($("drawTools"), () => active().drawings);

$("intervals").onclick = (e) => {
  const iv = e.target.closest("[data-iv]")?.dataset.iv;
  if (!iv) return;
  (state.sync.interval ? slots : [active()]).forEach((s) => s.setInterval(iv));
  persist(); renderHeader();
};
$("types").onclick = (e) => {
  const ty = e.target.closest("[data-ty]")?.dataset.ty;
  if (!ty) return;
  const a = active();
  a.type = ty; a.view.setType(ty);
  persist(); renderHeader();
};
$("replayBtn").onclick = () => { const r = active().replay; r.state === "off" ? r.start() : r.exit(); };
$("alertBtn").onclick = () => alerts.openDialog();
$("tradeBtn").onclick = () => trading.openTicket(active().symbol, "buy");
$("settingsBtn").onclick = () => openSettings();
$("screenerBtn").onclick = () => (screener.el.hidden ? screener.open() : screener.close());
$("themeBtn").onclick = () => openThemePicker();
$("indBtn").onclick = () => openIndicatorPicker();
$("fitBtn").onclick = () => active().view.fit();
$("symbolBtn").onclick = () => $("search").focus();

// ---------------- indicators (always on the active chart) ----------------

function addStudy(type) {
  const a = active(), def = INDICATORS[type];
  if (type === "vol" && a.studies.some((s) => s.type === "vol")) return toast("Volume is already on this chart");
  a.studies.push({ id: uid(), type, params: { ...def.params } });
  a.view.setStudies(a.studies);
  persist();
  toast(`Added ${def.label}${slots.length > 1 ? ` to ${short(a.symbol)}` : ""}`);
}

function removeStudy(slot, id) {
  slot.studies = slot.studies.filter((s) => s.id !== id);
  slot.view.setStudies(slot.studies);
  persist();
}

function openIndicatorPicker() {
  const a = active();
  const groups = {};
  for (const [id, d] of Object.entries(INDICATORS)) (groups[d.group] ??= []).push([id, d]);
  const m = modal(slots.length > 1 ? `Indicators — ${short(a.symbol)} chart` : "Indicators", `
    <input id="ind-q" class="wide-input" placeholder="Search indicators…" autocomplete="off" />
    <div id="ind-list">${Object.entries(groups).map(([g, list]) => `<div class="ind-group"><div class="muted small">${g}</div>
      ${list.map(([id, d]) => `<button class="ind-item" data-ind="${id}" data-name="${esc(d.label.toLowerCase())}">${esc(d.label)}<span class="muted small">${d.kind === "pane" ? "separate pane" : d.kind === "volume" ? "volume" : "on chart"}</span></button>`).join("")}</div>`).join("")}</div>
    <div class="muted small">On chart now: ${a.studies.map((s) => esc(shortLabel(s.type, s.params))).join(", ") || "none"} — click ⚙ in the chart legend or a pane label to change settings.</div>`);
  const q = m.el.querySelector("#ind-q");
  q.focus();
  q.oninput = () => m.el.querySelectorAll(".ind-item").forEach((b) => (b.hidden = !b.dataset.name.includes(q.value.toLowerCase())));
  m.el.querySelector("#ind-list").onclick = (e) => { const id = e.target.closest("[data-ind]")?.dataset.ind; if (id) addStudy(id); };
}

function editStudy(slot, id) {
  const s = slot.studies.find((x) => x.id === id);
  if (!s) return;
  const def = INDICATORS[s.type];
  const keys = Object.keys(def.params);
  if (!keys.length) return toast(`${def.label} has no settings`);
  const m = modal(`${def.label} settings`, `${keys.map((k) => `<label class="field"><span>${paramLabel(k)}</span><input type="number" step="any" min="0" data-k="${k}" value="${s.params[k]}" /></label>`).join("")}
    <div class="row-end"><button data-close>Cancel</button><button class="primary" id="st-ok">Apply</button></div>`);
  m.el.querySelector("[data-close]").onclick = m.close;
  m.el.querySelector("#st-ok").onclick = () => {
    m.el.querySelectorAll("[data-k]").forEach((i) => { const v = parseFloat(i.value); if (v > 0) s.params[i.dataset.k] = v; });
    slot.view.setStudies(slot.studies);
    persist();
    m.close();
  };
}

// ---------------- quotes (watchlist, alerts, positions) ----------------

async function loadQuotes() {
  const symbols = [...new Set([...watchlists.symbols(), ...alerts.symbols(), ...trading.symbols(), ...slots.map((s) => s.symbol)])];
  if (!symbols.length) return;
  try {
    const list = await api(`/api/quotes?symbols=${symbols.map(encodeURIComponent).join(",")}`);
    for (const q of list) if (!q.error) state.quotes[q.symbol] = q;
    bus.emit("quotes", state.quotes);
    if (!active()?.replay.active) trading.render();
  } catch { /* keep last quotes */ }
}

// ---------------- symbol selection & search ----------------

/** Opens a symbol in the active chart (or every chart when symbol sync is on). */
function selectSymbol(sym) {
  (state.sync.symbol ? slots : [active()]).forEach((s) => s.setSymbol(sym));
  persist();
  watchlists.setCurrent(sym);
  renderHeader();
}

let searchTimer, results = [], activeResult = -1;
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
      activeResult = results.length ? 0 : -1;
      renderResults();
    } catch { /* ignore */ }
  }, 220);
});
$("search").addEventListener("keydown", (e) => {
  if ($("results").hidden) return;
  if (e.key === "ArrowDown") { activeResult = Math.min(results.length - 1, activeResult + 1); renderResults(); e.preventDefault(); }
  if (e.key === "ArrowUp") { activeResult = Math.max(0, activeResult - 1); renderResults(); e.preventDefault(); }
  if (e.key === "Enter" && results[activeResult]) pickResult(results[activeResult]);
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
    ? results.map((r, i) => `<div class="${i === activeResult ? "active" : ""}" data-i="${i}"><b>${esc(short(r.symbol))}</b><em>${esc([r.type, r.exchange].filter(Boolean).join(" · "))}</em><small>${esc(r.name)} <span class="muted">${esc(r.symbol)}</span></small></div>`).join("")
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

// ---------------- keyboard shortcuts (act on the active chart) ----------------

document.addEventListener("keydown", (e) => {
  if (e.target.closest?.("input, textarea, select")) return;
  const a = active();
  if (e.key === "Escape") {
    if (!screener.el.hidden) { screener.close(); return; }
    a.drawings.cancel(); if (a.replay.state === "picking") a.replay.exit(); return;
  }
  if (!screener.el.hidden) return; // chart shortcuts are off while the screener is open
  if ((e.key === "Delete" || e.key === "Backspace") && a.drawings.deleteSelected()) { e.preventDefault(); return; }
  if (e.shiftKey && e.key === "ArrowRight" && a.replay.active) { e.preventDefault(); a.replay.step(); return; }
  if (e.shiftKey && e.code === "Space" && a.replay.active) { e.preventDefault(); a.replay.toggle(); return; }
  if (e.altKey) {
    const key = e.key.toLowerCase();
    const tool = TOOLS.find((t) => t.key && t.key.toLowerCase() === `alt+${e.shiftKey ? "shift+" : ""}${key}`);
    if (tool) { e.preventDefault(); a.drawings.setTool(tool.id); return; }
    if (key === "a") { e.preventDefault(); alerts.openDialog(); return; }
    if (key === "r" && !e.shiftKey) { e.preventDefault(); $("replayBtn").click(); return; }
    // Alt+1 … Alt+8 jump to a chart in the layout.
    if (/^[1-8]$/.test(e.key) && slots[+e.key - 1]) { e.preventDefault(); setActive(+e.key - 1); return; }
  }
  // Start typing anywhere to search, like TradingView.
  if (/^[a-z0-9^]$/i.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) $("search").focus();
});

// ---------------- boot ----------------

// Theme picker greets first-time visitors only; afterwards it opens from the 🎨 button.
if (!store.get("theme-seen", false)) {
  store.set("theme-seen", true);
  setTimeout(() => openThemePicker({ startup: true }), 400);
}
renderSidebar();
setLayout(state.layout);
setInterval(loadQuotes, 15000);
setInterval(() => slots.forEach((s) => s.refresh()), 10000);
