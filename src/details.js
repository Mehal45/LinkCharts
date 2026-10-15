// Symbol details panel (right sidebar, below the watchlist): price, stats, 52-week range, performance.
import { api, esc, short, fmtPx, fmtVol, signed, cls, precisionFor, fmtTime, currencySymbol } from "./util.js";

const PERIODS = [["1W", 7], ["1M", 30], ["3M", 91], ["6M", 182], ["YTD", "ytd"], ["1Y", 365]];

export class Details {
  constructor({ el, onTrade }) {
    this.el = el;
    this.onTrade = onTrade;
    this.meta = null;
    this.perf = null;
    this.perfFor = null;
  }

  async loadPerformance(symbol) {
    if (this.perfFor === symbol) return;
    this.perfFor = symbol;
    this.perf = null;
    try {
      const { candles } = await api(`/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d`);
      if (this.perfFor !== symbol || !candles.length) return;
      const last = candles[candles.length - 1];
      const at = (secondsAgo) => {
        const t = last.time - secondsAgo;
        for (let i = candles.length - 1; i >= 0; i--) if (candles[i].time <= t) return candles[i].close;
        return null;
      };
      const yearStart = Date.UTC(new Date(last.time * 1000).getUTCFullYear(), 0, 1) / 1000;
      this.perf = PERIODS.map(([label, days]) => {
        const base = days === "ytd" ? at(last.time - yearStart + 1) : at(days * 86400);
        return [label, base ? ((last.close - base) / base) * 100 : null];
      });
      this.render();
    } catch { /* performance is optional */ }
  }

  update(meta, livePrice) {
    this.meta = { ...meta, price: livePrice ?? meta.price };
    this.loadPerformance(meta.symbol);
    this.render();
  }

  render() {
    const m = this.meta;
    if (!m) return;
    const d = precisionFor(m.price, m.symbol);
    const ch = m.prevClose ? m.price - m.prevClose : 0, chp = m.prevClose ? (ch / m.prevClose) * 100 : 0;
    const pos = m.high52 > m.low52 ? ((m.price - m.low52) / (m.high52 - m.low52)) * 100 : 50;
    const dayPos = m.dayHigh > m.dayLow ? ((m.price - m.dayLow) / (m.dayHigh - m.dayLow)) * 100 : 50;
    const status = m.market === "crypto" ? "24/7 market" : m.marketOpen ? "Market open" : "Market closed";
    this.el.innerHTML = `
      <div class="dt-top">
        <div><div class="dt-sym">${esc(short(m.symbol))}</div><div class="muted small">${esc(m.name || "")}</div>
        <div class="muted small">${esc(m.exchange || "")} · ${esc(m.type === "INDEX" ? "Index" : m.type || "")} · ${esc(m.currency || "")}</div></div>
      </div>
      <div class="dt-price">${currencySymbol(m.currency)}${fmtPx(m.price, d)}</div>
      <div class="${cls(ch)}">${signed(ch, d)} (${signed(chp)}%)</div>
      <div class="muted small"><i class="mk ${m.marketOpen ? "open" : ""}"></i> ${status}${m.marketTime ? " · last " + fmtTime(m.marketTime, m.timezone) : ""}</div>
      <div class="dt-trade"><button class="sell" data-t="sell">Sell</button><button class="buy" data-t="buy">Buy</button></div>
      <div class="dt-range"><div class="muted small">Day's range</div><div class="bar"><i style="left:${clamp(dayPos)}%"></i></div>
        <div class="ends"><span>${fmtPx(m.dayLow, d)}</span><span>${fmtPx(m.dayHigh, d)}</span></div></div>
      <div class="dt-range"><div class="muted small">52-week range</div><div class="bar"><i style="left:${clamp(pos)}%"></i></div>
        <div class="ends"><span>${fmtPx(m.low52, d)}</span><span>${fmtPx(m.high52, d)}</span></div></div>
      <div class="stats">
        <span>Prev close</span><span>${fmtPx(m.prevClose, d)}</span>
        <span>Volume</span><span>${fmtVol(m.volume, m.currency)}</span>
      </div>
      ${this.perf ? `<div class="muted small dt-h">Performance</div><div class="perf">${this.perf.map(([l, v]) => `<div class="${cls(v)}"><b>${v == null ? "—" : signed(v) + "%"}</b><span>${l}</span></div>`).join("")}</div>` : ""}
      <p class="muted small">Not investment advice.</p>`;
    this.el.querySelector(".dt-trade").onclick = (e) => { const t = e.target.dataset.t; if (t) this.onTrade(m.symbol, t); };
  }
}

const clamp = (v) => Math.max(0, Math.min(100, v));
