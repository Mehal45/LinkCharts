// Long/Short position tools: risk/reward maths, a walk through the candles inside the box, and the settings dialog.
// A position drawing is { type: "long"|"short", points: [entry, target, stop], pos, style }, where
// points[0] = { time: start, price: entry }, points[1] = { time: end, price: target }, points[2] = { time: start, price: stop }.
import { store, modal, esc } from "./util.js";

const DEFAULT_POS = { account: 1000, lot: 1, riskMode: "%", risk: 1, leverage: 1, qtyPrecision: 2 };
const DEFAULT_STYLE = { line: "#787b86", width: 1, targetColor: "#089981", stopColor: "#f23645", textColor: "#ffffff", fontSize: 11, priceLabels: true, compact: false, alwaysStats: true };

export const isPosition = (d) => d.type === "long" || d.type === "short";
export const tickSize = (digits) => 10 ** -digits;
export const roundTo = (v, digits) => +v.toFixed(digits);

/** Inputs and style for a new position, starting from the last ones the user applied. */
export function newPositionFields() {
  const saved = store.get("position-defaults", {});
  return { pos: { ...DEFAULT_POS, ...saved.pos }, style: { ...DEFAULT_STYLE, ...saved.style } };
}

export const fmtQty = (q, d) => q.toLocaleString("en-US", { maximumFractionDigits: d.pos.qtyPrecision });

/**
 * Position size and stats. Qty is in lots: risk / (stop distance × lot size), capped by what the
 * account can buy at the given leverage, and rounded down so the risk is never exceeded.
 */
export function calc(d, digits) {
  const [entry, target, stop] = d.points.map((p) => p.price);
  const { account, lot, riskMode, risk, leverage, qtyPrecision } = d.pos;
  const riskAmt = riskMode === "%" ? (account * risk) / 100 : risk;
  const stopDist = Math.abs(entry - stop), targetDist = Math.abs(target - entry);
  let qty = stopDist > 0 && lot > 0 ? riskAmt / (stopDist * lot) : 0;
  if (entry > 0 && lot > 0 && leverage > 0) qty = Math.min(qty, (account * leverage) / (entry * lot));
  const f = 10 ** qtyPrecision;
  qty = Math.floor(qty * f + 1e-9) / f;
  const tick = tickSize(digits);
  return {
    entry, target, stop, riskAmt, qty,
    targetAmt: qty * lot * targetDist,
    stopAmt: qty * lot * stopDist,
    rr: stopDist ? targetDist / stopDist : 0,
    targetPct: entry ? (targetDist / entry) * 100 : 0,
    stopPct: entry ? (stopDist / entry) * 100 : 0,
    targetTicks: Math.round(targetDist / tick),
    stopTicks: Math.round(stopDist / tick),
  };
}

/**
 * Plays the trade through the candles between the box's start and end. It opens on the first bar that
 * reaches the entry price (or gaps across it), then closes at the target or stop (a bar that touches both counts as
 * the stop). Status: "pending" (entry never reached), "open", "target", "stop" or "expired" (box ended).
 */
export function simulate(d, candles, qty) {
  const long = d.type === "long";
  const [entry, target, stop] = d.points.map((p) => p.price);
  const start = d.points[0].time, end = d.points[1].time;
  let lo = 0, hi = candles.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (candles[mid].time < start) lo = mid + 1; else hi = mid; }
  let active = null, last = null;
  for (let i = lo; i < candles.length && candles[i].time <= end; i++) {
    const bar = candles[i];
    if (active == null) {
      // A bar that trades through the entry, or a gap from the previous close across it, opens the trade.
      const prev = i > 0 ? candles[i - 1].close : bar.open;
      if (Math.min(prev, bar.low) > entry || Math.max(prev, bar.high) < entry) continue;
      active = bar.time;
    }
    const hitStop = long ? bar.low <= stop : bar.high >= stop;
    const hitTarget = long ? bar.high >= target : bar.low <= target;
    if (hitStop || hitTarget) {
      const exitPrice = hitStop ? stop : target;
      return { status: hitStop ? "stop" : "target", activeTime: active, exitTime: bar.time, exitPrice, pnl: pnlAt(d, entry, exitPrice, qty) };
    }
    last = bar;
  }
  if (active == null) return { status: "pending", pnl: 0 };
  const ended = !candles.length || candles[candles.length - 1].time >= end;
  return { status: ended ? "expired" : "open", activeTime: active, exitTime: last.time, exitPrice: last.close, pnl: pnlAt(d, entry, last.close, qty) };
}

const pnlAt = (d, entry, exit, qty) => qty * d.pos.lot * (exit - entry) * (d.type === "long" ? 1 : -1);

// ---------------- settings dialog ----------------

const num = (k, v, step = "any") => `<input type="number" step="${step}" min="0" data-k="${k}" value="${v}" />`;
const color = (k, v) => `<input type="color" data-k="${k}" value="${v}" />`;
const options = (k, values, cur, fmt = (v) => v) => `<select data-k="${k}">${values.map((v) => `<option value="${v}" ${String(v) === String(cur) ? "selected" : ""}>${esc(fmt(v))}</option>`).join("")}</select>`;
const check = (k, on, label) => `<label class="pos-check"><input type="checkbox" data-k="${k}" ${on ? "checked" : ""}/> ${esc(label)}</label>`;

/** Opens the Inputs / Style dialog for a long or short position. `onApply` runs after the drawing is updated. */
export function openPositionSettings(d, { digits, currency, onApply }) {
  const tick = tickSize(digits), sign = d.type === "long" ? 1 : -1;
  const [entry, target, stop] = d.points.map((p) => p.price);
  const P = d.pos, S = d.style;
  const ticks = (a, b) => Math.round(Math.abs(a - b) / tick);
  const m = modal(`${d.type === "long" ? "Long" : "Short"} position settings`, `
    <div class="seg-toggle pos-tabs"><button class="on" data-tab="inputs">Inputs</button><button data-tab="style">Style</button></div>
    <div class="pos-form" data-pane="inputs">
      <div class="grid2">
        <label class="field"><span>Account size${currency ? ` (${esc(currency)})` : ""}</span>${num("account", P.account)}</label>
        <label class="field"><span>Lot size</span>${num("lot", P.lot)}</label>
        <label class="field"><span>Risk</span><span class="pos-pair">${num("risk", P.risk)}${options("riskMode", ["%", "amt"], P.riskMode, (v) => (v === "%" ? "%" : currency || "Amount"))}</span></label>
        <label class="field"><span>Leverage</span>${num("leverage", P.leverage)}</label>
      </div>
      <label class="field"><span>Entry price</span>${num("entry", entry)}</label>
      <div class="grid2">
        <label class="field"><span>Profit level, ticks</span>${num("tTicks", ticks(target, entry), 1)}</label>
        <label class="field"><span>Profit level, price</span>${num("tPrice", target)}</label>
        <label class="field"><span>Stop level, ticks</span>${num("sTicks", ticks(stop, entry), 1)}</label>
        <label class="field"><span>Stop level, price</span>${num("sPrice", stop)}</label>
      </div>
      <label class="field"><span>Qty precision</span>${options("qtyPrecision", [0, 1, 2, 3, 4, 5, 6, 7, 8], P.qtyPrecision)}</label>
    </div>
    <div class="pos-form" data-pane="style" hidden>
      <div class="grid2">
        <label class="field"><span>Lines</span><span class="pos-pair">${color("line", S.line)}${options("width", [1, 2, 3, 4], S.width, (v) => v + "px")}</span></label>
        <label class="field"><span>Text</span><span class="pos-pair">${color("textColor", S.textColor)}${options("fontSize", [10, 11, 12, 13, 14, 16], S.fontSize)}</span></label>
        <label class="field"><span>Target color</span>${color("targetColor", S.targetColor)}</label>
        <label class="field"><span>Stop color</span>${color("stopColor", S.stopColor)}</label>
      </div>
      ${check("priceLabels", S.priceLabels, "Price labels on the price axis")}
      ${check("compact", S.compact, "Compact stats mode")}
      ${check("alwaysStats", S.alwaysStats, "Always show stats (otherwise only when selected)")}
    </div>
    <div class="row-end"><span class="pos-err down small"></span><button data-close>Cancel</button><button class="primary" data-ok>Apply</button></div>`);

  const f = (k) => m.el.querySelector(`[data-k="${k}"]`);
  const val = (k) => parseFloat(f(k).value);

  m.el.querySelector(".pos-tabs").onclick = (e) => {
    const tab = e.target.closest("[data-tab]")?.dataset.tab;
    if (!tab) return;
    m.el.querySelectorAll("[data-tab]").forEach((b) => b.classList.toggle("on", b.dataset.tab === tab));
    m.el.querySelectorAll("[data-pane]").forEach((p) => (p.hidden = p.dataset.pane !== tab));
  };

  // Ticks and price describe the same level; editing one updates the other. Moving the entry keeps the tick distances.
  const fromTicks = (level) => { const t = val(level + "Ticks"), e = val("entry"); if (!Number.isNaN(t) && !Number.isNaN(e)) f(level + "Price").value = roundTo(e + (level === "t" ? sign : -sign) * t * tick, digits); };
  const fromPrice = (level) => { const p = val(level + "Price"), e = val("entry"); if (!Number.isNaN(p) && !Number.isNaN(e)) f(level + "Ticks").value = ticks(p, e); };
  f("entry").oninput = () => { fromTicks("t"); fromTicks("s"); };
  f("tTicks").oninput = () => fromTicks("t");
  f("sTicks").oninput = () => fromTicks("s");
  f("tPrice").oninput = () => fromPrice("t");
  f("sPrice").oninput = () => fromPrice("s");

  m.el.querySelector("[data-close]").onclick = m.close;
  m.el.querySelector("[data-ok]").onclick = () => {
    const err = (msg) => { m.el.querySelector(".pos-err").textContent = msg; };
    const e = val("entry"), t = val("tPrice"), s = val("sPrice");
    for (const k of ["account", "lot", "risk", "leverage"]) if (!(val(k) > 0)) return err("Account size, lot size, risk and leverage must be above 0.");
    if ([e, t, s].some(Number.isNaN)) return err("Enter entry, profit and stop prices.");
    if (d.type === "long" ? !(t > e && e > s) : !(t < e && e < s)) {
      return err(d.type === "long" ? "For a long, the profit level must be above the entry and the stop below it." : "For a short, the profit level must be below the entry and the stop above it.");
    }
    d.points[0] = { ...d.points[0], price: roundTo(e, digits) };
    d.points[1] = { ...d.points[1], price: roundTo(t, digits) };
    d.points[2] = { ...d.points[2], price: roundTo(s, digits) };
    d.pos = { account: val("account"), lot: val("lot"), riskMode: f("riskMode").value, risk: val("risk"), leverage: val("leverage"), qtyPrecision: +f("qtyPrecision").value };
    d.style = {
      line: f("line").value, width: +f("width").value, textColor: f("textColor").value, fontSize: +f("fontSize").value,
      targetColor: f("targetColor").value, stopColor: f("stopColor").value,
      priceLabels: f("priceLabels").checked, compact: f("compact").checked, alwaysStats: f("alwaysStats").checked,
    };
    d.color = d.style.line;
    store.set("position-defaults", { pos: d.pos, style: d.style });
    m.close();
    onApply?.();
  };
}
