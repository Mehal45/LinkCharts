// Chart view: main price chart + volume + indicator overlays + stacked indicator panes.
import { INDICATORS, shortLabel } from "./indicators.js";
import { $, esc, fmtPx, fmtVol, signed, cls, precisionFor, short, bus } from "./util.js";

const LC = window.LightweightCharts;

export const THEME = {
  layout: { background: { color: "#0f1115" }, textColor: "#9aa1ac", fontFamily: "Inter, sans-serif" },
  grid: { vertLines: { color: "#1a1f26" }, horzLines: { color: "#1a1f26" } },
  rightPriceScale: { borderColor: "#2a3039" },
  timeScale: { borderColor: "#2a3039", rightOffset: 8 },
  crosshair: { mode: LC.CrosshairMode.Normal },
  autoSize: true,
};

/** "#rrggbb" + opacity → "rgba(r,g,b,a)"; other color strings pass through. */
function alpha(color, a) {
  const m = /^#([0-9a-f]{6})$/i.exec(color || "");
  if (!m) return color;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

export class ChartView {
  constructor({ charts, mainPane, legend }) {
    this.chartsEl = charts;
    this.mainPane = mainPane;
    this.legendEl = legend;
    this.palette = { bg: "#0f1115", text: "#9aa1ac", grid: "#1a1f26", up: "#22ab94", down: "#f23645", line: "#2962ff", crosshair: "#758696" };
    this.chart = LC.createChart(mainPane, this.chartOptions());
    this.type = "candles";
    this.candles = [];
    this.meta = null;
    this.intraday = false;
    this.studies = [];
    this.overlaySeries = new Map(); // studyId -> [series]
    this.panes = new Map(); // studyId -> { el, chart, series: [] }
    this.price = null;
    this.volume = null;
    this.hover = null;
    this.chart.subscribeCrosshairMove((p) => {
      this.hover = p?.time != null ? p.time : null;
      this.renderLegend();
      const price = p?.point ? this.price?.coordinateToPrice(p.point.y) : null;
      bus.emit("crosshair", { time: p?.time ?? null, price, view: this, point: p?.point ?? null });
    });
    this._syncing = false;
    this._subscribeSync(this.chart);
    this.buildPriceSeries();
  }

  // ---------------- theme ----------------

  chartOptions() {
    const P = this.palette;
    return {
      ...THEME,
      layout: { ...THEME.layout, background: { type: "solid", color: P.bg }, textColor: P.text, fontFamily: getComputedStyle(document.documentElement).getPropertyValue("--font") || THEME.layout.fontFamily },
      grid: { vertLines: { color: P.grid || "rgba(0,0,0,0)", visible: !!P.grid }, horzLines: { color: P.grid || "rgba(0,0,0,0)", visible: !!P.grid } },
      rightPriceScale: { borderColor: alpha(P.text, 0.25) },
      timeScale: { ...THEME.timeScale, borderColor: alpha(P.text, 0.25) },
      crosshair: { mode: LC.CrosshairMode.Normal, vertLine: { color: P.crosshair, labelBackgroundColor: P.crosshair }, horzLine: { color: P.crosshair, labelBackgroundColor: P.crosshair } },
    };
  }

  /** Removes the chart and its indicator panes from the page. */
  dispose() {
    for (const p of this.panes.values()) { p.chart.remove(); p.el.remove(); }
    this.panes.clear();
    this.chart.remove();
  }

  /** Recolors everything for a theme's chart palette. */
  applyTheme(palette) {
    this.palette = palette;
    const { timeScale, ...opts } = this.chartOptions();
    this.chart.applyOptions({ ...opts, timeScale: { borderColor: timeScale.borderColor } });
    for (const p of this.panes.values()) p.chart.applyOptions({ ...opts, timeScale: { borderColor: timeScale.borderColor } });
    this.setType(this.type); // rebuilds the price series with the new candle colors
    if (this.volume && this.candles.length) this.volume.setData(this.volumeData(this.candles));
    this.renderStudies();
  }

  // ---------------- series ----------------

  buildPriceSeries() {
    const P = this.palette;
    if (this.price) this.chart.removeSeries(this.price);
    const fmt = this.priceFormat();
    if (this.type === "candles" || this.type === "hollow") {
      const hollow = this.type === "hollow";
      this.price = this.chart.addCandlestickSeries({
        priceFormat: fmt, borderVisible: hollow || !!P.hollowUp, upColor: hollow || P.hollowUp ? "rgba(0,0,0,0)" : P.up, downColor: P.down,
        borderUpColor: P.up, borderDownColor: P.down, wickUpColor: P.up, wickDownColor: P.down,
      });
    } else if (this.type === "bars") {
      this.price = this.chart.addBarSeries({ priceFormat: fmt, upColor: P.up, downColor: P.down, thinBars: false });
    } else if (this.type === "line") {
      this.price = this.chart.addLineSeries({ priceFormat: fmt, color: P.line, lineWidth: 2 });
    } else {
      this.price = this.chart.addAreaSeries({ priceFormat: fmt, lineColor: P.line, topColor: alpha(P.line, 0.35), bottomColor: alpha(P.line, 0), lineWidth: 2 });
    }
    bus.emit("price-series", { series: this.price, view: this });
  }

  priceFormat() {
    const last = this.candles[this.candles.length - 1]?.close ?? 100;
    const precision = precisionFor(last, this.meta?.symbol);
    return { type: "price", precision, minMove: 1 / 10 ** precision };
  }

  setType(type) {
    this.type = type;
    this.buildPriceSeries();
    if (this.candles.length) this.price.setData(this.priceData(this.candles));
  }

  priceData(c) {
    return this.type === "line" || this.type === "area"
      ? c.map(({ time, close }) => ({ time, value: close }))
      : c.map(({ time, open, high, low, close }) => ({ time, open, high, low, close }));
  }

  volumeData(c) {
    const up = alpha(this.palette.up, 0.4), down = alpha(this.palette.down, 0.4);
    return c.map((x) => ({ time: x.time, value: x.volume || 0, color: x.close >= x.open ? up : down }));
  }

  /** Replaces all data. `fitTail` = show the last N bars. */
  setData(candles, meta, { keepView = false } = {}) {
    const metaChanged = meta && meta.symbol !== this.meta?.symbol;
    this.candles = candles;
    if (meta) this.meta = meta;
    if (metaChanged) this.price.applyOptions({ priceFormat: this.priceFormat() });
    const range = keepView ? this.chart.timeScale().getVisibleLogicalRange() : null;
    this.price.setData(this.priceData(candles));
    this.volume?.setData(this.volumeData(candles));
    this.chart.applyOptions({ timeScale: { timeVisible: this.intraday, secondsVisible: false } });
    for (const p of this.panes.values()) p.chart.applyOptions({ timeScale: { timeVisible: this.intraday } });
    this.renderStudies();
    if (range) this.setRange(range);
    else {
      // New symbol/interval: the user may have dragged the price axis on the previous chart, which turns
      // auto-scaling off and would leave the old price range (e.g. 22,000 for a ₹5 stock). Turn it back on.
      this.resetPriceScales();
      this.showTail();
    }
    this.renderLegend();
  }

  resetPriceScales() {
    this.chart.priceScale("right").applyOptions({ autoScale: true });
    for (const p of this.panes.values()) p.chart.priceScale("right").applyOptions({ autoScale: true });
  }

  /** Applies bars at or after the current last bar (live updates) without touching the view. */
  mergeTail(candles) {
    const lastTime = this.candles[this.candles.length - 1]?.time ?? -Infinity;
    const fresh = candles.filter((c) => c.time >= lastTime);
    if (!fresh.length) return;
    for (const c of fresh) {
      if (this.candles.length && this.candles[this.candles.length - 1].time === c.time) this.candles[this.candles.length - 1] = c;
      else this.candles.push(c);
      this.price.update(this.priceData([c])[0]);
      this.volume?.update(this.volumeData([c])[0]);
    }
    this.renderStudies();
    this.renderLegend();
  }

  showTail(n) {
    const len = this.candles.length;
    const count = n ?? (this.intraday ? 160 : 200);
    this.setRange({ from: Math.max(0, len - count), to: len + 6 });
  }

  setRange(range) {
    this.chart.timeScale().setVisibleLogicalRange(range);
    for (const p of this.panes.values()) p.chart.timeScale().setVisibleLogicalRange(range);
  }

  fit() { this.chart.timeScale().fitContent(); }

  // ---------------- studies ----------------

  setStudies(studies) {
    this.studies = studies;
    const wantVol = studies.some((s) => s.type === "vol");
    if (wantVol && !this.volume) {
      this.volume = this.chart.addHistogramSeries({ priceFormat: { type: "volume" }, priceScaleId: "vol", lastValueVisible: false, priceLineVisible: false });
      this.chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
      if (this.candles.length) this.volume.setData(this.volumeData(this.candles));
    } else if (!wantVol && this.volume) {
      this.chart.removeSeries(this.volume);
      this.volume = null;
    }
    // Drop series for removed/changed studies.
    const ids = new Set(studies.map((s) => s.id));
    for (const [id, list] of this.overlaySeries) if (!ids.has(id)) { list.forEach((s) => this.chart.removeSeries(s)); this.overlaySeries.delete(id); }
    for (const [id, pane] of this.panes) if (!ids.has(id)) { pane.chart.remove(); pane.el.remove(); this.panes.delete(id); }
    this.layoutPanes();
    this.renderStudies();
    this.renderLegend(); // keep the legend's indicator chips (with ✕) in sync
  }

  layoutPanes() {
    const paneStudies = this.studies.filter((s) => INDICATORS[s.type]?.kind === "pane");
    for (const s of paneStudies) {
      if (this.panes.has(s.id)) continue;
      const el = document.createElement("div");
      el.className = "pane sub";
      el.innerHTML = `<div class="pane-label"></div><button class="pane-x" title="Remove">✕</button>`;
      el.querySelector(".pane-x").onclick = () => bus.emit("remove-study", s.id);
      this.chartsEl.appendChild(el);
      const opts = this.chartOptions();
      const chart = LC.createChart(el, { ...opts, timeScale: { ...opts.timeScale, timeVisible: this.intraday } });
      this._subscribeSync(chart);
      this.panes.set(s.id, { el, chart, series: [] });
    }
    paneStudies.forEach((s) => this.chartsEl.appendChild(this.panes.get(s.id).el));
    this.chartsEl.style.gridTemplateRows = ["1fr", ...paneStudies.map(() => "120px")].join(" ");
    const last = paneStudies[paneStudies.length - 1];
    this.chart.applyOptions({ timeScale: { visible: !last } });
    paneStudies.forEach((s) => this.panes.get(s.id).chart.applyOptions({ timeScale: { visible: s === last } }));
  }

  renderStudies() {
    if (!this.candles.length) return;
    for (const s of this.studies) {
      const def = INDICATORS[s.type];
      if (!def?.compute) continue;
      if (def.kind === "overlay" && s.type === "vwap" && !this.intraday) { this._setOverlay(s, { lines: [] }); continue; }
      let out;
      try { out = def.compute(this.candles, s.params); } catch { out = { lines: [] }; }
      if (def.kind === "overlay") this._setOverlay(s, out);
      else this._setPane(s, out);
    }
    const range = this.chart.timeScale().getVisibleLogicalRange();
    if (range) for (const p of this.panes.values()) p.chart.timeScale().setVisibleLogicalRange(range);
  }

  _makeLine(chart, line, inPane) {
    if (line.type === "histogram") return chart.addHistogramSeries({ priceLineVisible: false, lastValueVisible: false });
    return chart.addLineSeries({
      color: line.color, lineWidth: line.width ?? 1.5, lineStyle: line.style ?? 0,
      lineVisible: line.type !== "dots", pointMarkersVisible: line.type === "dots", pointMarkersRadius: 1.5,
      priceLineVisible: false, lastValueVisible: inPane, crosshairMarkerVisible: false,
    });
  }

  _setOverlay(study, out) {
    let list = this.overlaySeries.get(study.id);
    if (!list || list.length !== out.lines.length || list._sig !== JSON.stringify(study.params)) {
      list?.forEach((s) => this.chart.removeSeries(s));
      list = out.lines.map((l) => this._makeLine(this.chart, l, false));
      list._sig = JSON.stringify(study.params);
      this.overlaySeries.set(study.id, list);
    }
    out.lines.forEach((l, i) => list[i].setData(l.data));
  }

  _setPane(study, out) {
    const pane = this.panes.get(study.id);
    if (!pane) return;
    pane.el.querySelector(".pane-label").textContent = shortLabel(study.type, study.params);
    if (pane.series.length !== out.lines.length || pane._sig !== JSON.stringify(study.params)) {
      pane.series.forEach((s) => pane.chart.removeSeries(s));
      pane.series = out.lines.map((l) => this._makeLine(pane.chart, l, true));
      pane._sig = JSON.stringify(study.params);
      (out.levels || []).forEach((lvl) => pane.series[pane.series.length - 1]?.createPriceLine({ price: lvl, color: "#4a515c", lineStyle: 2, lineWidth: 1, axisLabelVisible: true, title: "" }));
    }
    // Histograms (e.g. MACD) take the theme's up/down colors.
    const up = alpha(this.palette.up, 0.6), down = alpha(this.palette.down, 0.6);
    out.lines.forEach((l, i) => pane.series[i].setData(l.type === "histogram" ? l.data.map((d) => ({ ...d, color: d.value >= 0 ? up : down })) : l.data));
  }

  _subscribeSync(chart) {
    chart.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (this._syncing || !range) return;
      this._syncing = true;
      for (const c of [this.chart, ...[...this.panes.values()].map((p) => p.chart)]) if (c !== chart) c.timeScale().setVisibleLogicalRange(range);
      this._syncing = false;
    });
  }

  // ---------------- legend ----------------

  renderLegend() {
    if (!this.candles.length || !this.meta) { this.legendEl.innerHTML = ""; return; }
    const c = this.candles;
    let i = c.length - 1;
    if (this.hover != null) { const j = this.indexOfTime(this.hover); if (j >= 0) i = j; }
    const bar = c[i], prev = i > 0 ? c[i - 1].close : bar.open;
    const ch = bar.close - prev, chp = (ch / prev) * 100, d = precisionFor(bar.close, this.meta.symbol);
    const studies = this.studies.filter((s) => ["overlay", "volume"].includes(INDICATORS[s.type]?.kind))
      .map((s) => `<span class="leg-study" data-study="${s.id}">${esc(shortLabel(s.type, s.params))}<b data-edit="${s.id}" title="Settings">⚙</b><b data-remove="${s.id}" title="Remove">✕</b></span>`).join("");
    this.legendEl.innerHTML = `
      <div class="l1"><b>${esc(short(this.meta.symbol))}</b><span class="muted">${esc(this.meta.name || "")} · ${esc(this.meta.exchange || "")}</span></div>
      <div class="l2">
        <span>O <i class="${cls(ch)}">${fmtPx(bar.open, d)}</i></span><span>H <i class="${cls(ch)}">${fmtPx(bar.high, d)}</i></span>
        <span>L <i class="${cls(ch)}">${fmtPx(bar.low, d)}</i></span><span>C <i class="${cls(ch)}">${fmtPx(bar.close, d)}</i></span>
        <span class="${cls(ch)}">${signed(ch, d)} (${signed(chp)}%)</span>
        ${bar.volume ? `<span class="muted">Vol ${fmtVol(bar.volume, this.meta.currency)}</span>` : ""}
      </div>
      <div class="l3">${studies}</div>`;
  }

  // ---------------- coordinate helpers (used by drawings, replay, trading) ----------------

  indexOfTime(t) {
    const c = this.candles;
    let lo = 0, hi = c.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].time === t) return mid;
      if (c[mid].time < t) lo = mid + 1; else hi = mid - 1;
    }
    return -1;
  }

  barSeconds() {
    const c = this.candles;
    if (c.length < 2) return 60;
    const diffs = [];
    for (let i = Math.max(1, c.length - 30); i < c.length; i++) diffs.push(c[i].time - c[i - 1].time);
    diffs.sort((a, b) => a - b);
    return diffs[Math.floor(diffs.length / 2)] || 60;
  }

  /** Fractional bar index for any time (interpolates gaps, extrapolates past the ends). */
  timeToLogical(t) {
    const c = this.candles;
    if (!c.length) return null;
    const step = this.barSeconds();
    if (t <= c[0].time) return (t - c[0].time) / step;
    if (t >= c[c.length - 1].time) return c.length - 1 + (t - c[c.length - 1].time) / step;
    let lo = 0, hi = c.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (c[mid].time <= t) lo = mid; else hi = mid; }
    return lo + (t - c[lo].time) / (c[hi].time - c[lo].time);
  }

  logicalToTime(l) {
    const c = this.candles;
    if (!c.length) return null;
    const step = this.barSeconds();
    if (l <= 0) return Math.round(c[0].time + l * step);
    if (l >= c.length - 1) return Math.round(c[c.length - 1].time + (l - (c.length - 1)) * step);
    const i = Math.floor(l), f = l - i;
    return Math.round(c[i].time + f * (c[i + 1].time - c[i].time));
  }

  timeToX(t) { const l = this.timeToLogical(t); return l == null ? null : this.chart.timeScale().logicalToCoordinate(l); }
  xToTime(x) { const l = this.chart.timeScale().coordinateToLogical(x); return l == null ? null : this.logicalToTime(l); }
  priceToY(p) { return this.price.priceToCoordinate(p); }
  yToPrice(y) { return this.price.coordinateToPrice(y); }
  paneWidth() { return this.chart.timeScale().width(); }
}
