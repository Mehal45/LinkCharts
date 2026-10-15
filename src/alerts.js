// Price alerts: above / below / crossing a level, once or every time.
// Checked against every live price the app sees (quote polls + live chart bars) while the app is open.
import { store, uid, esc, short, fmtPx, precisionFor, bus, toast, beep, notify, modal, fmtTime } from "./util.js";

const CONDITIONS = { above: "Price goes above", below: "Price goes below", cross: "Price crosses" };

export class Alerts {
  constructor({ el, getViews, getPrice, getSymbol }) {
    this.el = el;
    this.getViews = getViews;
    this.getPrice = getPrice;
    this.getSymbol = getSymbol;
    this.alerts = store.get("alerts", []);
    this.log = store.get("alert-log", []);
    this.lines = [];
    bus.on("quotes", (q) => { for (const [sym, x] of Object.entries(q)) if (x?.price != null && !x.error) this.check(sym, x.price); });
    bus.on("live-price", ({ symbol, price }) => this.check(symbol, price));
    bus.on("create-alert", (opts) => this.openDialog(opts));
    bus.on("price-series", () => this.drawLines());
    this.render();
  }

  symbols() { return [...new Set(this.alerts.filter((a) => a.active).map((a) => a.symbol))]; }
  save() { store.set("alerts", this.alerts); store.set("alert-log", this.log.slice(0, 200)); }

  check(symbol, price) {
    let changed = false;
    for (const a of this.alerts) {
      if (!a.active || a.symbol !== symbol) continue;
      const prev = a.last;
      a.last = price;
      const hit =
        (a.cond === "above" && price >= a.price && (prev == null || prev < a.price || a.armed)) ||
        (a.cond === "below" && price <= a.price && (prev == null || prev > a.price || a.armed)) ||
        (a.cond === "cross" && prev != null && (prev - a.price) * (price - a.price) <= 0 && prev !== price);
      a.armed = false;
      if (hit) { this.fire(a, price); changed = true; }
    }
    if (changed) { this.save(); this.render(); this.drawLines(); }
  }

  fire(a, price) {
    const d = precisionFor(price, a.symbol);
    const text = `${short(a.symbol)} ${a.cond === "cross" ? "crossed" : a.cond === "above" ? "is above" : "is below"} ${fmtPx(a.price, d)} (now ${fmtPx(price, d)})`;
    this.log.unshift({ id: uid(), at: Math.floor(Date.now() / 1000), symbol: a.symbol, text: text + (a.note ? ` — ${a.note}` : "") });
    if (a.once) a.active = false;
    else a.armed = false; // must re-cross before firing again
    toast("🔔 " + text, "alert");
    beep();
    notify("Price alert: " + short(a.symbol), text + (a.note ? `\n${a.note}` : ""));
  }

  openDialog({ symbol, price, edit } = {}) {
    const sym = edit?.symbol || symbol || this.getSymbol();
    const cur = this.getPrice(sym);
    const level = edit?.price ?? price ?? cur ?? 0;
    const d = precisionFor(level || 1, sym);
    const m = modal(edit ? "Edit alert" : `Create alert — ${short(sym)}`, `
      <label class="field"><span>Condition</span>
        <select id="al-cond">${Object.entries(CONDITIONS).map(([k, v]) => `<option value="${k}" ${k === (edit?.cond || (level >= (cur ?? level) ? "above" : "below")) ? "selected" : ""}>${v}</option>`).join("")}</select></label>
      <label class="field"><span>Price ${cur != null ? `<em class="muted">(now ${fmtPx(cur, d)})</em>` : ""}</span>
        <input id="al-price" type="number" step="any" value="${(+level).toFixed(d)}" /></label>
      <label class="field"><span>Trigger</span>
        <select id="al-once"><option value="1" ${edit?.once !== false ? "selected" : ""}>Only once</option><option value="0" ${edit?.once === false ? "selected" : ""}>Every time</option></select></label>
      <label class="field"><span>Message (optional)</span><input id="al-note" value="${esc(edit?.note || "")}" placeholder="e.g. breakout — check volume" /></label>
      <p class="muted small">Alerts are checked while this app is open (every ~15 s, or live for crypto). You'll get a sound, a pop-up and a desktop notification.</p>
      <div class="row-end"><button data-close>Cancel</button><button class="primary" id="al-save">${edit ? "Save" : "Create"}</button></div>`);
    m.el.querySelector("[data-close]").onclick = m.close;
    m.el.querySelector("#al-save").onclick = () => {
      const p = parseFloat(m.el.querySelector("#al-price").value);
      if (!Number.isFinite(p)) return;
      const fields = { cond: m.el.querySelector("#al-cond").value, price: p, once: m.el.querySelector("#al-once").value === "1", note: m.el.querySelector("#al-note").value.trim() };
      if (edit) Object.assign(edit, fields, { active: true, last: null, armed: true });
      else this.alerts.push({ id: uid(), symbol: sym, ...fields, active: true, createdAt: Math.floor(Date.now() / 1000), last: cur ?? null, armed: false });
      if ("Notification" in window && Notification.permission === "default") Notification.requestPermission();
      this.save(); this.render(); this.drawLines();
      bus.emit("watch-symbols");
      toast(`Alert ${edit ? "updated" : "created"} for ${short(sym)}`);
      m.close();
    };
  }

  render() {
    const active = this.alerts.filter((a) => a.active), inactive = this.alerts.filter((a) => !a.active);
    const row = (a) => `<div class="al-row ${a.active ? "" : "off"}" data-id="${a.id}">
      <div><b data-go="${esc(a.symbol)}">${esc(short(a.symbol))}</b> <span class="muted">${a.cond === "cross" ? "crosses" : a.cond}</span> ${fmtPx(a.price, precisionFor(a.price, a.symbol))}
      ${a.note ? `<div class="muted small">${esc(a.note)}</div>` : ""}<div class="muted small">${a.once ? "Once" : "Every time"}${a.active ? "" : " · triggered/stopped"}</div></div>
      <div class="al-acts">
        <button class="icon" data-act="toggle" title="${a.active ? "Pause" : "Restart"}">${a.active ? "⏸" : "▶"}</button>
        <button class="icon" data-act="edit" title="Edit">✎</button>
        <button class="icon" data-act="del" title="Delete">✕</button>
      </div></div>`;
    this.el.innerHTML = `
      <div class="wl-head"><b>Alerts</b><button class="icon" data-act="new" title="Create alert for the current symbol (Alt+A)">＋</button></div>
      <div class="al-list">${active.map(row).join("") || `<div class="empty-note">No active alerts. Press ＋ or Alt+A, or select a horizontal line and click 🔔.</div>`}
      ${inactive.length ? `<div class="wl-sec">Stopped</div>${inactive.map(row).join("")}` : ""}</div>
      <div class="wl-sec">Log <button class="x" data-act="clearlog" title="Clear log">✕</button></div>
      <div class="al-log">${this.log.slice(0, 50).map((l) => `<div><span class="muted small">${fmtTime(l.at)}</span><br/>${esc(l.text)}</div>`).join("") || `<div class="empty-note">Nothing triggered yet.</div>`}</div>`;
    this.el.onclick = (e) => {
      const act = e.target.closest("[data-act]")?.dataset.act;
      const go = e.target.closest("[data-go]")?.dataset.go;
      if (go) { bus.emit("open-symbol", go); return; }
      if (act === "new") return this.openDialog();
      if (act === "clearlog") { this.log = []; this.save(); this.render(); return; }
      const a = this.alerts.find((x) => x.id === e.target.closest("[data-id]")?.dataset.id);
      if (!a) return;
      if (act === "toggle") { a.active = !a.active; a.armed = true; a.last = null; }
      if (act === "edit") return this.openDialog({ edit: a });
      if (act === "del") this.alerts = this.alerts.filter((x) => x !== a);
      this.save(); this.render(); this.drawLines();
    };
  }

  /** Draws active alerts as dashed lines on every chart currently showing that symbol. */
  drawLines() {
    for (const { s, line } of this.lines) try { s.removePriceLine(line); } catch { /* series replaced */ }
    this.lines = [];
    for (const view of this.getViews()) {
      const sym = view.meta?.symbol;
      if (!sym || !view.price) continue;
      for (const a of this.alerts.filter((x) => x.active && x.symbol === sym)) {
        this.lines.push({ s: view.price, line: view.price.createPriceLine({ price: a.price, color: getComputedStyle(document.documentElement).getPropertyValue("--warn").trim() || "#f7c948", lineStyle: 1, lineWidth: 1, axisLabelVisible: true, title: "🔔" }) });
      }
    }
  }

}
