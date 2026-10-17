// Stock screener view: market/exchange, presets, filter pills, sortable table, lazy performance columns.
import { api, esc, store, bus, toast, askText, fmtPx, fmtVol, signed, cls, currencySymbol, short } from "./util.js";

// ---------------- number helpers ----------------

/** Parses "1.5L", "2Cr", "500K", "3.2M", "1B" etc. */
export function parseAmount(v) {
  if (v == null || v === "") return null;
  const m = /^\s*(-?[\d.,]+)\s*(k|l|lakh|cr|crore|m|b|t)?\s*$/i.exec(String(v));
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ""));
  const mult = { k: 1e3, l: 1e5, lakh: 1e5, cr: 1e7, crore: 1e7, m: 1e6, b: 1e9, t: 1e12 }[(m[2] || "").toLowerCase()] || 1;
  return Number.isFinite(n) ? n * mult : null;
}
const fmtAmount = (v, ccy) => {
  if (v == null) return "";
  if (ccy === "INR") {
    if (Math.abs(v) >= 1e7) return +(v / 1e7).toFixed(2) + "Cr";
    if (Math.abs(v) >= 1e5) return +(v / 1e5).toFixed(2) + "L";
  }
  if (Math.abs(v) >= 1e12) return +(v / 1e12).toFixed(2) + "T";
  if (Math.abs(v) >= 1e9) return +(v / 1e9).toFixed(2) + "B";
  if (Math.abs(v) >= 1e6) return +(v / 1e6).toFixed(2) + "M";
  if (Math.abs(v) >= 1e3) return +(v / 1e3).toFixed(1) + "K";
  return String(+v.toFixed(2));
};
const fmtMcap = (v, ccy) => (v == null ? "—" : currencySymbol(ccy) + fmtAmount(v, ccy));
const pct = (v) => (v == null || !Number.isFinite(v) ? "—" : signed(v) + "%");

// ---------------- filters & columns ----------------

// server: true = also sent to Yahoo to narrow the universe before precise client-side filtering.
const FILTERS = [
  { id: "price", label: "Price", kind: "range", field: "price", server: ["priceMin", "priceMax"], unit: "ccy" },
  { id: "changePct", label: "Change %", kind: "range", field: "changePct", server: ["chgMin", "chgMax"], unit: "%" },
  { id: "volume", label: "Volume", kind: "range", field: "volume", server: ["volMin", "volMax"], unit: "amount" },
  { id: "relVol", label: "Rel. volume", kind: "range", field: "relVol", unit: "×" },
  { id: "mcap", label: "Market cap", kind: "range", field: "mcap", server: ["mcapMin", "mcapMax"], unit: "amount" },
  { id: "pe", label: "P/E", kind: "range", field: "pe", unit: "" },
  { id: "divYield", label: "Div. yield %", kind: "range", field: "divYield", unit: "%" },
  { id: "sector", label: "Sector", kind: "sector" },
  { id: "fromHigh52", label: "% from 52W high", kind: "range", field: "fromHigh52", unit: "%" },
  { id: "fromLow52", label: "% above 52W low", kind: "range", field: "fromLow52", unit: "%" },
  { id: "chg52w", label: "52W change %", kind: "range", field: "chg52w", unit: "%" },
  { id: "vs50", label: "vs 50-day MA %", kind: "range", field: "vs50", unit: "%" },
  { id: "vs200", label: "vs 200-day MA %", kind: "range", field: "vs200", unit: "%" },
];

const COLUMNS = [
  { id: "price", label: "Price", get: (r) => r.price, fmt: (v, r) => fmtPx(v, v < 1 ? 4 : 2) },
  { id: "changePct", label: "Chg %", get: (r) => r.changePct, fmt: pct, color: true },
  { id: "change", label: "Chg", get: (r) => r.change, fmt: (v) => (v == null ? "—" : signed(v)), color: true },
  { id: "volume", label: "Volume", get: (r) => r.volume, fmt: (v, r) => fmtVol(v, r.currency) },
  { id: "relVol", label: "Rel vol", get: (r) => r.relVol, fmt: (v) => (v == null ? "—" : v.toFixed(2) + "×"), hot: (v) => v >= 2 },
  { id: "mcap", label: "Mkt cap", get: (r) => r.mcap, fmt: (v, r) => fmtMcap(v, r.currency) },
  { id: "turnover", label: "Value traded", get: (r) => r.turnover, fmt: (v, r) => fmtMcap(v, r.currency) },
  { id: "pe", label: "P/E", get: (r) => r.pe, fmt: (v) => (v == null ? "—" : v.toFixed(1)) },
  { id: "eps", label: "EPS (TTM)", get: (r) => r.eps, fmt: (v) => (v == null ? "—" : v.toFixed(2)), off: true },
  { id: "pb", label: "P/B", get: (r) => r.pb, fmt: (v) => (v == null ? "—" : v.toFixed(2)), off: true },
  { id: "divYield", label: "Div %", get: (r) => r.divYield, fmt: (v) => (v == null ? "—" : v.toFixed(2) + "%") },
  { id: "high52", label: "52W high", get: (r) => r.high52, fmt: (v) => fmtPx(v, v < 1 ? 4 : 2), off: true },
  { id: "fromHigh52", label: "From 52W high", get: (r) => r.fromHigh52, fmt: pct, color: true },
  { id: "chg52w", label: "52W chg", get: (r) => r.chg52w, fmt: pct, color: true },
  { id: "vs50", label: "vs 50 MA", get: (r) => r.vs50, fmt: pct, color: true, off: true },
  { id: "vs200", label: "vs 200 MA", get: (r) => r.vs200, fmt: pct, color: true, off: true },
  { id: "w1", field: "perf.w1", label: "Perf 1W", get: (r) => r.perf?.w1, fmt: pct, color: true, perf: true },
  { id: "m1", field: "perf.m1", label: "Perf 1M", get: (r) => r.perf?.m1, fmt: pct, color: true, perf: true },
  { id: "m3", field: "perf.m3", label: "Perf 3M", get: (r) => r.perf?.m3, fmt: pct, color: true, perf: true, off: true },
  { id: "m6", field: "perf.m6", label: "Perf 6M", get: (r) => r.perf?.m6, fmt: pct, color: true, perf: true, off: true },
  { id: "ytd", field: "perf.ytd", label: "Perf YTD", get: (r) => r.perf?.ytd, fmt: pct, color: true, perf: true },
  { id: "y1", field: "perf.y1", label: "Perf 1Y", get: (r) => r.perf?.y1, fmt: pct, color: true, perf: true, off: true },
  { id: "exchange", label: "Exchange", get: (r) => r.exchange, fmt: (v) => esc(v || ""), text: true, off: true },
  { id: "rating", label: "Analyst rating", get: (r) => r.rating, fmt: (v) => esc(v || "—"), text: true, off: true },
];

const PRESETS = [
  { id: "all", label: "All stocks", filters: {}, sort: ["mcap", "desc"] },
  { id: "gainers", label: "Top gainers", filters: { changePct: { min: 0 } }, sort: ["changePct", "desc"] },
  { id: "losers", label: "Top losers", filters: { changePct: { max: 0 } }, sort: ["changePct", "asc"] },
  { id: "active", label: "Most active", filters: {}, sort: ["volume", "desc"] },
  { id: "unusual", label: "Unusual volume", filters: { relVol: { min: 2 } }, sort: ["relVol", "desc"] },
  { id: "high52", label: "Near 52-week high", filters: { fromHigh52: { min: -2 } }, sort: ["fromHigh52", "desc"] },
  { id: "low52", label: "Near 52-week low", filters: { fromLow52: { max: 3 } }, sort: ["fromLow52", "asc"] },
  { id: "large", label: "Large caps", filters: {}, sort: ["mcap", "desc"], limit: 100 },
  { id: "value", label: "Low P/E (value)", filters: { pe: { min: 0.01, max: 15 } }, sort: ["pe", "asc"] },
  { id: "dividend", label: "High dividend", filters: { divYield: { min: 3 } }, sort: ["divYield", "desc"] },
  { id: "uptrend", label: "Above 50 & 200 MA", filters: { vs50: { min: 0 }, vs200: { min: 0 } }, sort: ["vs200", "desc"] },
];

const PAGE = 100;
const exLabel = (r) => (/\.NS$/.test(r.symbol) ? "NSE" : /\.BO$/.test(r.symbol) ? "BSE" : (r.exchange || "").replace(/^Nasdaq\w*$/i, "NASDAQ"));

// ---------------- view ----------------

export class Screener {
  constructor({ el, onOpenSymbol, onAddToWatchlist }) {
    this.el = el;
    this.onOpenSymbol = onOpenSymbol;
    this.onAddToWatchlist = onAddToWatchlist;
    const saved = store.get("screener", {});
    this.state = {
      market: saved.market || "india",
      exchanges: saved.exchanges || [],
      filters: saved.filters || {},
      sectors: saved.sectors || [],
      sort: saved.sort || ["mcap", "desc"],
      columns: saved.columns || COLUMNS.filter((c) => !c.off).map((c) => c.id),
      preset: saved.preset || "all",
      limit: saved.limit || 500,
      universe: saved.universe || "nifty500",
      dedupe: saved.dedupe ?? true,
      page: 0,
    };
    this.meta = null;
    this.data = null;
    this.loading = false;
    this.perf = new Map();
    this.openPill = null;
  }

  save() {
    const { market, exchanges, filters, sectors, sort, columns, preset, limit, dedupe, universe } = this.state;
    store.set("screener", { market, exchanges, filters, sectors, sort, columns, preset, limit, dedupe, universe });
  }

  async open() {
    this.el.hidden = false;
    if (!this.meta) {
      try { this.meta = await api("/api/screener/meta"); } catch (e) { this.el.innerHTML = `<div class="error">${esc(e.message)}</div>`; return; }
    }
    this.render();
    if (!this.data) this.run();
  }

  close() { this.el.hidden = true; }

  get market() { return this.meta.markets[this.state.market]; }

  /** True if the loaded data has this field for at least one stock (e.g. India has no market cap or P/E). */
  available(field) {
    if (!this.data?.rows?.length || !field) return true;
    if (field.startsWith("perf.")) return true;
    return this.data.rows.some((r) => r[field] != null);
  }
  get currency() { return this.market.currency; }

  // ---------------- data ----------------

  serverFilters() {
    const out = {};
    for (const f of FILTERS) {
      const v = this.state.filters[f.id];
      if (!f.server || !v) continue;
      if (v.min != null) out[f.server[0]] = v.min;
      if (v.max != null) out[f.server[1]] = v.max;
    }
    if (this.state.sectors.length) out.sectors = this.state.sectors;
    return out;
  }

  async run() {
    this.loading = true;
    this.state.page = 0;
    this.renderTable();
    try {
      const valid = this.state.exchanges.filter((e) => this.market.exchanges?.[e]);
      this.data = await api("/api/screener", { body: { market: this.state.market, universe: this.state.universe, exchanges: valid, filters: this.serverFilters(), limit: this.state.limit } });
      this.error = null;
    } catch (e) {
      this.error = e.message;
      this.data = null;
    }
    this.loading = false;
    this.render(); // re-draw presets/filters: some depend on which fields this market's data has
  }

  /** Rows after precise client-side filtering + sorting. */
  rows() {
    if (!this.data) return [];
    let rows = this.data.rows.map((r) => ({ ...r, perf: r.perf ?? this.perf.get(r.symbol) }));
    if (this.state.sectors.length) rows = rows.filter((r) => !r.sector || this.state.sectors.includes(r.sector));
    if (this.state.dedupe) {
      // A company listed on two exchanges (e.g. RELIANCE.NS and RELIANCE.BO): keep the primary listing.
      const primary = new Set(rows.filter((r) => /\.NS$/.test(r.symbol)).map((r) => r.symbol.replace(/\.NS$/, "")));
      rows = rows.filter((r) => !(/\.BO$/.test(r.symbol) && primary.has(r.symbol.replace(/\.BO$/, ""))));
    }
    for (const f of FILTERS) {
      const v = this.state.filters[f.id];
      if (!v || f.kind !== "range") continue;
      rows = rows.filter((r) => {
        const x = r[f.field];
        if (x == null || !Number.isFinite(x)) return false;
        return (v.min == null || x >= v.min) && (v.max == null || x <= v.max);
      });
    }
    let [key, dir] = this.state.sort;
    if (key !== "symbol" && !this.available(COLUMNS.find((c) => c.id === key)?.field ?? key)) key = "turnover";
    const col = COLUMNS.find((c) => c.id === key);
    const get = key === "symbol" ? (r) => r.symbol : col ? col.get : (r) => r[key];
    const mul = dir === "asc" ? 1 : -1;
    rows.sort((a, b) => {
      const x = get(a), y = get(b);
      if (x == null && y == null) return 0;
      if (x == null) return 1; // missing values always last
      if (y == null) return -1;
      return (typeof x === "string" ? x.localeCompare(y) : x - y) * mul;
    });
    return rows;
  }

  async loadPerf(symbols) {
    const hasPerf = new Set((this.data?.rows || []).filter((r) => r.perf).map((r) => r.symbol));
    const missing = symbols.filter((s) => !this.perf.has(s) && !hasPerf.has(s));
    if (!missing.length || !this.state.columns.some((id) => COLUMNS.find((c) => c.id === id)?.perf)) return;
    missing.forEach((s) => this.perf.set(s, null));
    try {
      const list = await api(`/api/perf?symbols=${missing.map(encodeURIComponent).join(",")}`);
      for (const p of list) this.perf.set(p.symbol, p.error ? null : p);
    } catch { missing.forEach((s) => this.perf.delete(s)); }
    this.renderTable();
  }

  // ---------------- rendering ----------------

  render() {
    const m = this.market;
    const exchanges = Object.entries(m.exchanges);
    this.el.innerHTML = `
      <div class="sc-top">
        <h2>Stock screener</h2>
        <select id="sc-market" title="Market">${Object.entries(this.meta.markets).map(([k, v]) => `<option value="${k}" ${k === this.state.market ? "selected" : ""}>${esc(v.label)}</option>`).join("")}</select>
        ${m.universes ? `<label class="small">Universe <select id="sc-universe">${Object.entries(m.universes).map(([k, l]) => `<option value="${k}" ${k === this.state.universe ? "selected" : ""}>${esc(l)}</option>`).join("")}</select></label>`
          : `<div class="sc-ex">${exchanges.map(([code, name]) => `<label><input type="checkbox" data-ex="${code}" ${!this.state.exchanges.length || this.state.exchanges.includes(code) ? "checked" : ""}/> ${esc(name)}</label>`).join("")}</div>`}
        ${Object.keys(m.exchanges).length > 1 && this.state.market === "india" ? `<label class="small"><input type="checkbox" id="sc-dedupe" ${this.state.dedupe ? "checked" : ""}/> Hide BSE copies of NSE stocks</label>` : ""}
        <span class="spacer"></span>
        <span class="muted small" title="Where the data comes from">${esc(m.source || "")}</span>
        <label class="muted small" ${m.universes ? "hidden" : ""}>Scan top <select id="sc-limit">${[250, 500, 1000, 1500].map((n) => `<option ${n === this.state.limit ? "selected" : ""}>${n}</option>`).join("")}</select> by market cap</label>
        <button id="sc-refresh" title="Refresh data">⟳ Refresh</button>
        <button class="icon" id="sc-close" title="Back to chart (Esc)">✕</button>
      </div>
      <div class="sc-presets">${PRESETS.map((p) => { const need = Object.keys(p.filters).find((k) => !this.available(FILTERS.find((f) => f.id === k)?.field)); return `<button data-preset="${p.id}" class="${p.id === this.state.preset ? "on" : ""}" ${need ? `disabled title="Not available for this market (no ${esc(FILTERS.find((f) => f.id === need).label)} data)"` : ""}>${esc(p.label)}</button>`; }).join("")}</div>
      <div class="sc-pills" id="sc-pills"></div>
      <div class="sc-bar" id="sc-bar"></div>
      <div class="sc-table-wrap" id="sc-wrap"></div>`;
    this.bindTop();
    this.renderPills();
    this.renderTable();
  }

  bindTop() {
    const $ = (s) => this.el.querySelector(s);
    $("#sc-close").onclick = () => this.close();
    $("#sc-refresh").onclick = () => { this.perf.clear(); this.run(); };
    $("#sc-market").onchange = (e) => {
      this.state.market = e.target.value;
      this.state.exchanges = [];
      this.save(); this.render(); this.run();
    };
    $("#sc-limit").onchange = (e) => { this.state.limit = +e.target.value; this.save(); this.run(); };
    const dd = $("#sc-dedupe");
    if (dd) dd.onchange = () => { this.state.dedupe = dd.checked; this.save(); this.renderTable(); };
    const uni = $("#sc-universe");
    if (uni) uni.onchange = () => { this.state.universe = uni.value; this.save(); this.run(); };
    const exBox = this.el.querySelector(".sc-ex");
    if (exBox) exBox.onchange = () => {
      const all = [...this.el.querySelectorAll("[data-ex]")];
      const checked = all.filter((i) => i.checked).map((i) => i.dataset.ex);
      this.state.exchanges = checked.length === all.length ? [] : checked;
      if (!checked.length) { all.forEach((i) => (i.checked = true)); this.state.exchanges = []; }
      this.save(); this.run();
    };
    this.el.querySelector(".sc-presets").onclick = (e) => {
      const p = PRESETS.find((x) => x.id === e.target.dataset.preset);
      if (!p) return;
      this.state.preset = p.id;
      this.state.filters = structuredClone(p.filters);
      this.state.sectors = [];
      this.state.sort = [...p.sort];
      if (p.limit) this.state.limit = p.limit;
      this.save(); this.render(); this.run();
    };
  }

  renderPills() {
    const box = this.el.querySelector("#sc-pills");
    const valueText = (f) => {
      if (f.kind === "sector") return this.state.sectors.length ? (this.state.sectors.length === 1 ? this.state.sectors[0] : `${this.state.sectors.length} sectors`) : "";
      const v = this.state.filters[f.id];
      if (!v) return "";
      const show = (x) => (f.unit === "amount" ? fmtAmount(x, this.currency) : f.unit === "ccy" ? currencySymbol(this.currency) + x : x + (f.unit === "%" ? "%" : f.unit === "×" ? "×" : ""));
      if (v.min != null && v.max != null) return `${show(v.min)} – ${show(v.max)}`;
      if (v.min != null) return `≥ ${show(v.min)}`;
      if (v.max != null) return `≤ ${show(v.max)}`;
      return "";
    };
    box.innerHTML = FILTERS.filter((f) => f.kind !== "range" || this.available(f.field)).map((f) => {
      const val = valueText(f);
      return `<div class="pill-wrap"><button class="fpill ${val ? "set" : ""}" data-pill="${f.id}">${esc(f.label)}${val ? `: <b>${esc(val)}</b>` : " ▾"}</button>
        ${this.openPill === f.id ? this.pillEditor(f) : ""}</div>`;
    }).join("") + `<button class="fpill clear" data-clear>Reset filters</button>`;
    box.onclick = (e) => {
      if ("clear" in e.target.dataset) { this.state.filters = {}; this.state.sectors = []; this.state.preset = "all"; this.openPill = null; this.save(); this.render(); this.run(); return; }
      const id = e.target.closest("[data-pill]")?.dataset.pill;
      if (id && !e.target.closest(".pill-pop")) { this.openPill = this.openPill === id ? null : id; this.renderPills(); }
    };
    const pop = box.querySelector(".pill-pop");
    if (pop) this.bindPillEditor(pop);
  }

  pillEditor(f) {
    if (f.kind === "sector") {
      return `<div class="pill-pop"><div class="sector-list">${(this.data?.sectors || this.meta.sectors).map((s) => `<label><input type="checkbox" data-sector="${esc(s)}" ${this.state.sectors.includes(s) ? "checked" : ""}/> ${esc(s)}</label>`).join("")}</div>
        <div class="row-end"><button data-pop="clear">Clear</button><button class="primary" data-pop="apply">Apply</button></div></div>`;
    }
    const v = this.state.filters[f.id] || {};
    const hint = f.unit === "amount" ? (this.currency === "INR" ? "e.g. 10L, 5Cr, 1000Cr" : "e.g. 500K, 2M, 10B") : f.unit === "%" ? "percent, e.g. 5 or -3" : f.unit === "×" ? "e.g. 2 = twice the 3-month average" : "";
    const fmt = (x) => (x == null ? "" : f.unit === "amount" ? fmtAmount(x, this.currency) : x);
    return `<div class="pill-pop">
      <div class="grid2"><label class="field"><span>Min</span><input data-pop="min" value="${esc(fmt(v.min))}" placeholder="any" /></label>
      <label class="field"><span>Max</span><input data-pop="max" value="${esc(fmt(v.max))}" placeholder="any" /></label></div>
      ${hint ? `<div class="muted small">${esc(hint)}</div>` : ""}
      <div class="row-end"><button data-pop="clear">Clear</button><button class="primary" data-pop="apply">Apply</button></div></div>`;
  }

  bindPillEditor(pop) {
    const f = FILTERS.find((x) => x.id === this.openPill);
    const apply = (clear) => {
      if (f.kind === "sector") {
        this.state.sectors = clear ? [] : [...pop.querySelectorAll("[data-sector]:checked")].map((i) => i.dataset.sector);
      } else if (clear) delete this.state.filters[f.id];
      else {
        const parse = (s) => (f.unit === "amount" ? parseAmount(s) : s.trim() === "" ? null : parseFloat(s));
        const min = parse(pop.querySelector('[data-pop="min"]').value), max = parse(pop.querySelector('[data-pop="max"]').value);
        if (min == null && max == null) delete this.state.filters[f.id];
        else this.state.filters[f.id] = { min: Number.isFinite(min) ? min : null, max: Number.isFinite(max) ? max : null };
      }
      this.state.preset = null;
      this.openPill = null;
      this.save();
      this.render();
      // Filters Yahoo can apply narrow the universe → refetch; the rest are instant client-side.
      if (this.state.market !== "india" && (f.server || f.kind === "sector")) this.run();
      else this.renderTable();
    };
    pop.onclick = (e) => { const a = e.target.dataset.pop; if (a === "apply") apply(false); if (a === "clear") apply(true); };
    pop.onkeydown = (e) => { if (e.key === "Enter") apply(false); if (e.key === "Escape") { this.openPill = null; this.renderPills(); } };
    pop.querySelector("input")?.focus();
  }

  renderTable() {
    const wrap = this.el.querySelector("#sc-wrap");
    const bar = this.el.querySelector("#sc-bar");
    if (!wrap) return;
    if (this.loading) { bar.innerHTML = `<span class="muted">Scanning…</span>`; wrap.innerHTML = `<div class="empty-note">Scanning stocks… the first scan downloads a year of prices for each stock (about 5–20 seconds), then it is cached for a few minutes.</div>`; return; }
    if (this.error) { bar.innerHTML = ""; wrap.innerHTML = `<div class="error-note">${esc(this.error)}</div>`; return; }
    if (!this.data) return;
    const rows = this.rows();
    const pages = Math.max(1, Math.ceil(rows.length / PAGE));
    this.state.page = Math.min(this.state.page, pages - 1);
    const pageRows = rows.slice(this.state.page * PAGE, (this.state.page + 1) * PAGE);
    const cols = this.state.columns.map((id) => COLUMNS.find((c) => c.id === id)).filter((c) => c && this.available(c.field ?? c.id));
    // Where there is no market cap (India), show value traded instead so the default sort is visible.
    if (!this.available("mcap") && !cols.some((c) => c.id === "turnover")) cols.splice(Math.min(5, cols.length), 0, COLUMNS.find((c) => c.id === "turnover"));
    const [sk, sd] = this.state.sort;
    const arrow = (id) => (sk === id ? (sd === "desc" ? " ▼" : " ▲") : "");
    bar.innerHTML = `
      <span><b>${rows.length.toLocaleString()}</b> match${rows.length === 1 ? "" : "es"} <span class="muted">· ${esc(this.data.universe || `scanned ${this.data.returned.toLocaleString()} largest of ${this.data.total.toLocaleString()} stocks`)}</span></span>
      <span class="spacer"></span>
      <div class="menu"><button id="sc-cols">☷ Columns</button><div class="menu-pop right" id="sc-cols-pop" hidden>
        ${COLUMNS.map((c) => `<label class="col-opt"><input type="checkbox" data-col="${c.id}" ${this.state.columns.includes(c.id) ? "checked" : ""}/> ${esc(c.label)}${c.perf ? ' <span class="muted small">(loads per page)</span>' : ""}</label>`).join("")}
      </div></div>
      <button id="sc-watch" title="Save the current results as a new watchlist">☆ Save as watchlist</button>
      <span class="muted small">Page ${this.state.page + 1}/${pages}</span>
      <button class="small" data-page="-1" ${this.state.page === 0 ? "disabled" : ""}>‹</button>
      <button class="small" data-page="1" ${this.state.page >= pages - 1 ? "disabled" : ""}>›</button>`;
    wrap.innerHTML = rows.length ? `<table class="tbl sc-table">
      <thead><tr><th data-sort="symbol">Symbol${arrow("symbol")}</th>${cols.map((c) => `<th data-sort="${c.id}" class="${c.text ? "" : "num"}">${esc(c.label)}${arrow(c.id)}</th>`).join("")}<th></th></tr></thead>
      <tbody>${pageRows.map((r) => `<tr data-sym="${esc(r.symbol)}">
        <td class="sym-cell"><b>${esc(short(r.symbol))}</b><em class="ex-tag">${esc(exLabel(r))}</em><span>${esc(r.name)}</span></td>
        ${cols.map((c) => {
          const v = c.get(r);
          const pending = c.perf && r.perf === undefined;
          return `<td class="${c.text ? "" : "num"} ${c.color ? cls(v) : ""} ${c.hot?.(v) ? "hot" : ""}">${pending ? '<span class="muted">…</span>' : c.fmt(v, r)}</td>`;
        }).join("")}
        <td><button class="icon small" data-add="${esc(r.symbol)}" title="Add to the current watchlist">＋</button></td>
      </tr>`).join("")}</tbody></table>` : `<div class="empty-note">No stocks match these filters. Try widening a range or press Reset filters.</div>`;

    bar.onclick = (e) => {
      if (e.target.id === "sc-cols") { this.el.querySelector("#sc-cols-pop").hidden = !this.el.querySelector("#sc-cols-pop").hidden; return; }
      if (e.target.id === "sc-watch") return this.saveAsWatchlist(rows);
      const pg = e.target.dataset.page;
      if (pg) { this.state.page += +pg; this.renderTable(); wrap.scrollTop = 0; }
    };
    bar.onchange = (e) => {
      const id = e.target.dataset.col;
      if (!id) return;
      const set = new Set(this.state.columns);
      e.target.checked ? set.add(id) : set.delete(id);
      this.state.columns = COLUMNS.map((c) => c.id).filter((c) => set.has(c));
      this.save();
      this.renderTable();
      this.el.querySelector("#sc-cols-pop").hidden = false;
    };
    wrap.onclick = (e) => {
      const th = e.target.closest("[data-sort]");
      if (th) {
        const id = th.dataset.sort;
        this.state.sort = [id, sk === id && sd === "desc" ? "asc" : "desc"];
        this.state.page = 0;
        this.save(); this.renderTable();
        // Sorting by a performance column needs data for every row, not just this page.
        if (COLUMNS.find((c) => c.id === id)?.perf) this.loadPerf(this.rows().map((r) => r.symbol).slice(0, 100));
        return;
      }
      const add = e.target.closest("[data-add]")?.dataset.add;
      if (add) { this.onAddToWatchlist([add]); return; }
      const sym = e.target.closest("tr[data-sym]")?.dataset.sym;
      if (sym) this.onOpenSymbol(sym);
    };
    this.loadPerf(pageRows.map((r) => r.symbol));
  }

  async saveAsWatchlist(rows) {
    if (!rows.length) return;
    const name = await askText("Save as watchlist", { label: `Name for a new watchlist with ${Math.min(rows.length, 200)} symbols`, value: `Screener — ${PRESETS.find((p) => p.id === this.state.preset)?.label || "custom"}`, okText: "Save watchlist" });
    if (!name) return;
    bus.emit("create-watchlist", { name, symbols: rows.slice(0, 200).map((r) => r.symbol) });
    toast(`Saved ${Math.min(rows.length, 200)} symbols to “${name}”`, "ok");
  }
}

