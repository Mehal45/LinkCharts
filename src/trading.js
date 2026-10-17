// Paper trading with two separate virtual accounts: "live" (current prices) and "replay"
// (prices from bar replay). Market/limit/stop orders, optional stop-loss & take-profit (OCO),
// long and short positions, realized/unrealized P&L. Everything stays in this browser.
import { store, uid, esc, short, fmtPx, fmtMoney, signed, cls, precisionFor, bus, toast, modal, fmtTime, askConfirm } from "./util.js";

const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const START = { INR: 1_000_000, USD: 100_000, EUR: 100_000, GBP: 100_000, JPY: 10_000_000 };
const startFor = (ccy) => START[ccy] ?? 100_000;
const freshAccount = () => ({ cash: {}, positions: {}, orders: [], fills: [], realized: {} });

export class Trading {
  constructor({ el, getViews, getPrice, getMeta, isReplay }) {
    this.el = el;
    this.getViews = getViews;
    this.getPrice = getPrice; // (symbol) => last price (live) or replay close
    this.getMeta = getMeta; // (symbol) => { currency, ... } if known
    this.isReplay = isReplay;
    this.accounts = store.get("paper", { live: freshAccount(), replay: freshAccount() });
    this.tab = "positions";
    this.lines = [];
    bus.on("quotes", (q) => { if (!this.isReplay()) for (const [s, x] of Object.entries(q)) if (x?.price != null && !x.error) this.onPrice(s, { price: x.price }); });
    bus.on("live-price", ({ symbol, price, high, low }) => { if (!this.isReplay()) this.onPrice(symbol, { price, high, low }); });
    bus.on("replay-bar", ({ symbol, bar }) => this.onPrice(symbol, { price: bar.close, high: bar.high, low: bar.low, open: bar.open, time: bar.time }));
    bus.on("price-series", () => this.drawLines());
    bus.on("replay-mode", () => { this.render(); this.drawLines(); });
    this.render();
  }

  get mode() { return this.isReplay() ? "replay" : "live"; }
  get acct() { return this.accounts[this.mode]; }
  save() { store.set("paper", this.accounts); }
  symbols() { return [...new Set([...Object.keys(this.accounts.live.positions), ...this.accounts.live.orders.filter((o) => o.status === "open").map((o) => o.symbol)])]; }

  currencyOf(symbol) { return this.getMeta(symbol)?.currency || (/\.(NS|BO)$|^\^(NSE|BSE|CNX)/.test(symbol) ? "INR" : "USD"); }
  ensureCash(acct, ccy) { if (acct.cash[ccy] == null) acct.cash[ccy] = startFor(ccy); }
  now() { return this.isReplay() ? (this.replayTime ?? Math.floor(Date.now() / 1000)) : Math.floor(Date.now() / 1000); }

  // ---------------- order entry ----------------

  place({ symbol, side, type, qty, price, sl, tp }) {
    const acct = this.acct;
    qty = Math.abs(+qty);
    if (!(qty > 0)) return toast("Enter a quantity above 0", "error");
    const last = this.getPrice(symbol);
    if (last == null) return toast("No price yet for " + short(symbol), "error");
    if (type !== "market" && !(+price > 0)) return toast("Enter a limit/stop price", "error");
    const order = { id: uid(), symbol, side, type, qty, price: type === "market" ? null : +price, sl: +sl || null, tp: +tp || null, status: "open", created: this.now(), mode: this.mode };
    acct.orders.unshift(order);
    if (type === "market") this.fill(acct, order, last);
    else this.tryFill(acct, order, { price: last });
    this.save(); this.render(); this.drawLines();
    if (order.status === "open") toast(`${type === "limit" ? "Limit" : "Stop"} ${side} ${qty} ${short(symbol)} @ ${fmtPx(order.price)} placed`);
  }

  /** Checks whether an open order fills against a price update ({price, high?, low?, open?}). */
  tryFill(acct, o, { price, high = price, low = price, open = price }) {
    if (o.status !== "open") return;
    const buy = o.side === "buy";
    if (o.type === "limit") {
      if (buy && low <= o.price) this.fill(acct, o, Math.min(o.price, open));
      else if (!buy && high >= o.price) this.fill(acct, o, Math.max(o.price, open));
    } else if (o.type === "stop") {
      if (buy && high >= o.price) this.fill(acct, o, Math.max(o.price, open));
      else if (!buy && low <= o.price) this.fill(acct, o, Math.min(o.price, open));
    }
  }

  fill(acct, o, px) {
    const ccy = this.currencyOf(o.symbol);
    this.ensureCash(acct, ccy);
    const signedQty = o.side === "buy" ? o.qty : -o.qty;
    const pos = acct.positions[o.symbol] || { qty: 0, avg: 0, ccy };
    let realized = 0;
    if (pos.qty !== 0 && Math.sign(pos.qty) !== Math.sign(signedQty)) {
      const closing = Math.min(Math.abs(pos.qty), Math.abs(signedQty));
      realized = (px - pos.avg) * closing * Math.sign(pos.qty);
    }
    const newQty = pos.qty + signedQty;
    if (newQty === 0) delete acct.positions[o.symbol];
    else {
      if (pos.qty === 0 || Math.sign(pos.qty) === Math.sign(signedQty)) pos.avg = (pos.avg * Math.abs(pos.qty) + px * Math.abs(signedQty)) / Math.abs(newQty);
      else if (Math.sign(newQty) !== Math.sign(pos.qty)) pos.avg = px; // flipped through zero
      pos.qty = newQty;
      acct.positions[o.symbol] = pos;
    }
    acct.cash[ccy] -= signedQty * px;
    acct.realized[ccy] = (acct.realized[ccy] || 0) + realized;
    o.status = "filled";
    o.fillPrice = px;
    o.filled = this.now();
    acct.fills.unshift({ id: uid(), symbol: o.symbol, side: o.side, qty: o.qty, price: px, realized, time: o.filled, ccy });
    toast(`${o.side === "buy" ? "Bought" : "Sold"} ${o.qty} ${short(o.symbol)} @ ${fmtPx(px, precisionFor(px, o.symbol))}${realized ? ` · P&L ${fmtMoney(realized, ccy)}` : ""}`, realized < 0 ? "error" : "ok");

    // OCO: one exit filled → cancel its sibling.
    if (o.oco) for (const x of acct.orders) if (x.oco === o.oco && x.id !== o.id && x.status === "open") x.status = "cancelled";
    // Bracket: attach stop-loss / take-profit exits after an entry fills.
    if (o.sl || o.tp) {
      const exitSide = o.side === "buy" ? "sell" : "buy", group = uid();
      if (o.sl) acct.orders.unshift({ id: uid(), symbol: o.symbol, side: exitSide, type: "stop", qty: o.qty, price: o.sl, status: "open", created: this.now(), oco: group, tag: "SL" });
      if (o.tp) acct.orders.unshift({ id: uid(), symbol: o.symbol, side: exitSide, type: "limit", qty: o.qty, price: o.tp, status: "open", created: this.now(), oco: group, tag: "TP" });
    }
  }

  onPrice(symbol, bar) {
    if (bar.time) this.replayTime = bar.time;
    const acct = this.acct;
    let touched = false;
    for (const o of [...acct.orders]) {
      if (o.symbol !== symbol || o.status !== "open") continue;
      this.tryFill(acct, o, bar);
      if (o.status !== "open") touched = true;
    }
    if (touched) { this.save(); this.drawLines(); }
    if (acct.positions[symbol] || touched) this.render();
  }

  closePosition(symbol) {
    const pos = this.acct.positions[symbol];
    if (!pos) return;
    this.cancelExits(symbol);
    this.place({ symbol, side: pos.qty > 0 ? "sell" : "buy", type: "market", qty: Math.abs(pos.qty) });
  }

  cancelExits(symbol) {
    for (const o of this.acct.orders) if (o.symbol === symbol && o.status === "open" && o.oco) o.status = "cancelled";
  }

  async reset() {
    if (!(await askConfirm("Reset paper account", `Reset the ${this.mode} paper account? All positions, orders and history will be cleared.`, { okText: "Reset account", danger: true }))) return;
    this.accounts[this.mode] = freshAccount();
    this.save(); this.render(); this.drawLines();
  }

  // ---------------- order ticket ----------------

  openTicket(symbol, side = "buy") {
    const last = this.getPrice(symbol);
    const d = precisionFor(last ?? 1, symbol), ccy = this.currencyOf(symbol);
    this.ensureCash(this.acct, ccy);
    const m = modal(`${this.mode === "replay" ? "Replay" : "Paper"} order — ${short(symbol)}`, `
      <div class="seg-toggle" id="tk-side"><button data-v="buy" class="${side === "buy" ? "on buy" : ""}">Buy</button><button data-v="sell" class="${side === "sell" ? "on sell" : ""}">Sell</button></div>
      <div class="seg-toggle" id="tk-type"><button data-v="market" class="on">Market</button><button data-v="limit">Limit</button><button data-v="stop">Stop</button></div>
      <div class="grid2">
        <label class="field"><span>Quantity</span><input id="tk-qty" type="number" min="0" step="any" value="${last && last < 50 && ccy !== "INR" ? 10 : 1}" /></label>
        <label class="field"><span>Price</span><input id="tk-price" type="number" step="any" value="${last != null ? last.toFixed(d) : ""}" disabled /></label>
        <label class="field"><span>Stop-loss (optional)</span><input id="tk-sl" type="number" step="any" placeholder="—" /></label>
        <label class="field"><span>Take-profit (optional)</span><input id="tk-tp" type="number" step="any" placeholder="—" /></label>
      </div>
      <div class="ticket-sum" id="tk-sum"></div>
      <div class="row-end"><button data-close>Cancel</button><button class="primary" id="tk-go">Place order</button></div>`);
    let s = side, t = "market";
    const $m = (id) => m.el.querySelector(id);
    const sum = () => {
      const q = +$m("#tk-qty").value || 0, p = t === "market" ? last : +$m("#tk-price").value || 0;
      $m("#tk-sum").innerHTML = `Value ≈ <b>${fmtMoney(q * p, ccy)}</b> · Cash ${fmtMoney(this.acct.cash[ccy], ccy)} · ${this.mode === "replay" ? "Replay account" : "Live paper account"}`;
      $m("#tk-go").className = "primary " + s;
      $m("#tk-go").textContent = `${s === "buy" ? "Buy" : "Sell"} ${q || ""} ${short(symbol)}`;
    };
    $m("#tk-side").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; s = v; m.el.querySelectorAll("#tk-side button").forEach((b) => (b.className = b.dataset.v === v ? `on ${v}` : "")); sum(); };
    $m("#tk-type").onclick = (e) => { const v = e.target.dataset.v; if (!v) return; t = v; m.el.querySelectorAll("#tk-type button").forEach((b) => b.classList.toggle("on", b.dataset.v === v)); $m("#tk-price").disabled = v === "market"; sum(); };
    m.el.oninput = sum;
    m.el.querySelector("[data-close]").onclick = m.close;
    $m("#tk-go").onclick = () => {
      this.place({ symbol, side: s, type: t, qty: $m("#tk-qty").value, price: $m("#tk-price").value, sl: $m("#tk-sl").value, tp: $m("#tk-tp").value });
      m.close();
    };
    sum();
  }

  // ---------------- bottom panel ----------------

  render() {
    const acct = this.acct, mode = this.mode;
    const positions = Object.entries(acct.positions);
    const open = acct.orders.filter((o) => o.status === "open");
    const ccys = [...new Set([...Object.keys(acct.cash), ...positions.map(([, p]) => p.ccy)])];
    const unreal = {};
    for (const [s, p] of positions) {
      const last = this.getPrice(s);
      if (last != null) unreal[p.ccy] = (unreal[p.ccy] || 0) + (last - p.avg) * p.qty;
    }
    const tabs = [["positions", `Positions (${positions.length})`], ["orders", `Orders (${open.length})`], ["history", "History"], ["account", "Account"]];
    let body = "";
    if (this.tab === "positions") {
      body = positions.length ? `<table class="tbl"><tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Avg</th><th>Last</th><th>P&L</th><th>P&L %</th><th></th></tr>
        ${positions.map(([s, p]) => {
          const last = this.getPrice(s), d = precisionFor(p.avg, s);
          const pnl = last != null ? (last - p.avg) * p.qty : null, pct = last != null ? ((last - p.avg) / p.avg) * 100 * Math.sign(p.qty) : null;
          return `<tr><td><b data-go="${esc(s)}">${esc(short(s))}</b></td><td class="${p.qty > 0 ? "up" : "down"}">${p.qty > 0 ? "Long" : "Short"}</td><td>${Math.abs(p.qty)}</td>
            <td>${fmtPx(p.avg, d)}</td><td>${fmtPx(last, d)}</td><td class="${cls(pnl)}">${pnl == null ? "—" : fmtMoney(pnl, p.ccy)}</td><td class="${cls(pct)}">${pct == null ? "—" : signed(pct) + "%"}</td>
            <td><button class="small" data-close="${esc(s)}">Close</button></td></tr>`;
        }).join("")}</table>` : `<div class="empty-note">No open positions in the ${mode} account. Use Buy/Sell on the chart or the ticket.</div>`;
    } else if (this.tab === "orders") {
      body = open.length ? `<table class="tbl"><tr><th>Symbol</th><th>Side</th><th>Type</th><th>Qty</th><th>Price</th><th>Placed</th><th></th></tr>
        ${open.map((o) => `<tr><td><b data-go="${esc(o.symbol)}">${esc(short(o.symbol))}</b></td><td class="${o.side === "buy" ? "up" : "down"}">${o.side}</td>
          <td>${o.type}${o.tag ? ` (${o.tag})` : ""}</td><td>${o.qty}</td><td>${fmtPx(o.price, precisionFor(o.price, o.symbol))}</td><td>${fmtTime(o.created)}</td>
          <td><button class="small" data-cancel="${o.id}">Cancel</button></td></tr>`).join("")}</table>` : `<div class="empty-note">No working orders.</div>`;
    } else if (this.tab === "history") {
      body = acct.fills.length ? `<table class="tbl"><tr><th>Time</th><th>Symbol</th><th>Side</th><th>Qty</th><th>Price</th><th>Realized P&L</th></tr>
        ${acct.fills.slice(0, 200).map((f) => `<tr><td>${fmtTime(f.time)}</td><td>${esc(short(f.symbol))}</td><td class="${f.side === "buy" ? "up" : "down"}">${f.side}</td><td>${f.qty}</td>
          <td>${fmtPx(f.price, precisionFor(f.price, f.symbol))}</td><td class="${cls(f.realized)}">${f.realized ? fmtMoney(f.realized, f.ccy) : "—"}</td></tr>`).join("")}</table>` : `<div class="empty-note">No trades yet.</div>`;
    } else {
      const shown = ccys.length ? ccys : [this.currencyOf(this.getSymbol?.() || "")];
      body = `<table class="tbl"><tr><th>Currency</th><th>Starting</th><th>Cash</th><th>Realized P&L</th><th>Unrealized P&L</th></tr>
        ${shown.map((c) => `<tr><td>${c}</td><td>${fmtMoney(startFor(c), c)}</td><td>${fmtMoney(acct.cash[c] ?? startFor(c), c)}</td>
          <td class="${cls(acct.realized[c])}">${fmtMoney(acct.realized[c] || 0, c)}</td><td class="${cls(unreal[c])}">${fmtMoney(unreal[c] || 0, c)}</td></tr>`).join("")}</table>
        <p class="muted small">Each currency gets its own virtual balance the first time you trade in it. No fees, slippage or margin are modelled.</p>
        <button class="small danger" data-reset>Reset ${mode} account</button>`;
    }
    this.el.innerHTML = `
      <div class="bp-head">
        <span class="badge ${mode}">${mode === "replay" ? "⏪ Replay paper account" : "📄 Live paper account"}</span>
        ${tabs.map(([k, l]) => `<button class="bp-tab ${this.tab === k ? "on" : ""}" data-tab="${k}">${l}</button>`).join("")}
        <span class="spacer"></span>
        ${Object.entries(unreal).map(([c, v]) => `<span class="${cls(v)}">Open P&L ${fmtMoney(v, c)}</span>`).join(" ")}
        <button class="icon" data-collapse title="Collapse/expand panel">▾</button>
      </div>
      <div class="bp-body">${body}</div>`;
    this.el.onclick = (e) => {
      const t = e.target;
      if (t.dataset.tab) { this.tab = t.dataset.tab; this.render(); }
      else if (t.dataset.close) this.closePosition(t.dataset.close);
      else if (t.dataset.cancel) { const o = acct.orders.find((x) => x.id === t.dataset.cancel); if (o) o.status = "cancelled"; this.save(); this.render(); this.drawLines(); }
      else if (t.dataset.go) bus.emit("open-symbol", t.dataset.go);
      else if ("reset" in t.dataset) this.reset();
      else if ("collapse" in t.dataset) document.body.classList.toggle("bp-collapsed");
    };
  }

  /** Draws the position (entry price) and working orders on every chart showing that symbol. */
  drawLines() {
    for (const { s, line } of this.lines) try { s.removePriceLine(line); } catch { /* series replaced */ }
    this.lines = [];
    const acct = this.acct;
    for (const view of this.getViews()) {
      const sym = view.meta?.symbol, series = view.price;
      if (!sym || !series) continue;
      const pos = acct.positions[sym];
      if (pos) this.lines.push({ s: series, line: series.createPriceLine({ price: pos.avg, color: pos.qty > 0 ? cssVar("--up") : cssVar("--down"), lineWidth: 2, lineStyle: 0, axisLabelVisible: true, title: `${pos.qty > 0 ? "LONG" : "SHORT"} ${Math.abs(pos.qty)}` }) });
      for (const o of acct.orders.filter((x) => x.status === "open" && x.symbol === sym)) {
        this.lines.push({ s: series, line: series.createPriceLine({ price: o.price, color: o.tag === "SL" ? cssVar("--down") : o.tag === "TP" ? cssVar("--up") : cssVar("--accent"), lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: `${o.tag || o.type.toUpperCase()} ${o.side} ${o.qty}` }) });
      }
    }
  }

}
