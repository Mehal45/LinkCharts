// Multiple watchlists, each with collapsible sections; drag rows to reorder.
// List: { id, name, items: [{ t: "sec", id, title, collapsed } | { t: "sym", s }] }
import { store, uid, esc, short, fmtPx, signed, cls, precisionFor, bus, toast, askText, askConfirm } from "./util.js";

const sec = (title) => ({ t: "sec", id: uid(), title, collapsed: false });
const syms = (...list) => list.map((s) => ({ t: "sym", s }));

const DEFAULT_LISTS = () => [
  { id: uid(), name: "India", items: [
    sec("Indices"), ...syms("^NSEI", "^BSESN", "^NSEBANK", "^CNXIT"),
    sec("Large caps"), ...syms("RELIANCE.NS", "TCS.NS", "HDFCBANK.NS", "INFY.NS", "ICICIBANK.NS", "SBIN.NS", "BHARTIARTL.NS", "ITC.NS", "LT.NS", "BAJFINANCE.NS"),
  ] },
  { id: uid(), name: "US", items: [
    sec("Indices"), ...syms("^GSPC", "^IXIC", "^DJI", "^VIX"),
    sec("Tech"), ...syms("AAPL", "MSFT", "NVDA", "GOOGL", "AMZN", "META", "TSLA"),
    sec("ETFs"), ...syms("SPY", "QQQ"),
  ] },
  { id: uid(), name: "Crypto", items: syms("BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "DOGE-USD", "ADA-USD") },
  { id: uid(), name: "Forex & commodities", items: [
    sec("Forex"), ...syms("USDINR=X", "EURUSD=X", "GBPUSD=X", "USDJPY=X", "DX-Y.NYB"),
    sec("Commodities"), ...syms("GC=F", "SI=F", "CL=F", "NG=F"),
  ] },
  { id: uid(), name: "World indices", items: syms("^FTSE", "^GDAXI", "^FCHI", "^N225", "^HSI", "000001.SS") },
];

export class Watchlists {
  constructor({ el, onSelect }) {
    this.el = el;
    this.onSelect = onSelect;
    this.lists = store.get("watchlists", null) || DEFAULT_LISTS();
    this.activeId = store.get("watchlist-active", this.lists[0].id);
    if (!this.lists.some((l) => l.id === this.activeId)) this.activeId = this.lists[0].id;
    this.quotes = {};
    this.current = null;
    bus.on("quotes", (q) => { this.quotes = q; this.renderRows(); });
    bus.on("create-watchlist", ({ name, symbols }) => {
      const l = { id: uid(), name, items: symbols.map((s) => ({ t: "sym", s })) };
      this.lists.push(l);
      this.activeId = l.id;
      this.save(); this.render(); bus.emit("watch-symbols");
    });
    this.render();
  }

  /** Adds symbols to the active list (skipping ones already there). */
  addSymbols(symbols) {
    const have = new Set(this.active.items.filter((i) => i.t === "sym").map((i) => i.s));
    const added = symbols.filter((s) => !have.has(s));
    added.forEach((s) => this.active.items.push({ t: "sym", s }));
    this.save(); this.renderRows(); bus.emit("watch-symbols");
    toast(added.length ? `Added ${added.map(short).join(", ")} to “${this.active.name}”` : "Already in this watchlist");
  }

  get active() { return this.lists.find((l) => l.id === this.activeId); }
  symbols() { return this.active.items.filter((i) => i.t === "sym").map((i) => i.s); }
  save() { store.set("watchlists", this.lists); store.set("watchlist-active", this.activeId); }
  setCurrent(sym) { this.current = sym; this.renderRows(); }

  render() {
    this.el.innerHTML = `
      <div class="wl-head">
        <select class="wl-select" title="Switch watchlist">${this.lists.map((l) => `<option value="${l.id}" ${l.id === this.activeId ? "selected" : ""}>${esc(l.name)}</option>`).join("")}</select>
        <button class="icon" data-a="add" title="Add the current chart's symbol">＋</button>
        <button class="icon" data-a="section" title="Add a section">§</button>
        <div class="menu"><button class="icon" data-a="menu" title="Watchlist options">⋯</button>
          <div class="menu-pop right" hidden>
            <button data-a="new">New watchlist</button>
            <button data-a="rename">Rename</button>
            <button data-a="dup">Duplicate</button>
            <button data-a="delete" class="danger">Delete watchlist</button>
            <button data-a="reset">Restore default lists</button>
          </div>
        </div>
      </div>
      <div class="wl-cols"><span>Symbol</span><span>Last</span><span>Chg</span><span>Chg%</span></div>
      <div class="wl-rows"></div>`;
    this.el.querySelector(".wl-select").onchange = (e) => { this.activeId = e.target.value; this.save(); this.renderRows(); bus.emit("watch-symbols"); };
    this.el.querySelector(".wl-head").onclick = (e) => this.onHeadAction(e.target.closest("[data-a]")?.dataset.a);
    this.bindRows();
    this.renderRows();
  }

  async onHeadAction(a) {
    const pop = this.el.querySelector(".menu-pop");
    if (a === "menu") { pop.hidden = !pop.hidden; return; }
    pop.hidden = true;
    const list = this.active;
    if (a === "add" && this.current) {
      if (!list.items.some((i) => i.t === "sym" && i.s === this.current)) list.items.push({ t: "sym", s: this.current });
    }
    if (a === "section") {
      const title = await askText("Add a section", { label: "Section name", placeholder: "e.g. Banks, IT, Swing trades", okText: "Add section" });
      if (!title) return;
      list.items.push(sec(title.toUpperCase()));
    }
    if (a === "new") {
      const name = await askText("New watchlist", { label: "Watchlist name", value: "My watchlist", okText: "Create" });
      if (!name) return;
      const l = { id: uid(), name, items: [] };
      this.lists.push(l);
      this.activeId = l.id;
    }
    if (a === "rename") {
      const n = await askText("Rename watchlist", { label: "Watchlist name", value: list.name, okText: "Rename" });
      if (!n) return;
      list.name = n;
    }
    if (a === "dup") { const l = { ...structuredClone(list), id: uid(), name: list.name + " copy" }; this.lists.push(l); this.activeId = l.id; }
    if (a === "delete") {
      if (this.lists.length === 1) return toast("You need at least one watchlist.", "error");
      if (!(await askConfirm("Delete watchlist", `Delete "${list.name}" and the ${list.items.filter((i) => i.t === "sym").length} symbols in it?`, { okText: "Delete", danger: true }))) return;
      this.lists = this.lists.filter((l) => l !== list);
      this.activeId = this.lists[0].id;
    }
    if (a === "reset" && await askConfirm("Restore default lists", "Add back the default India, US, Crypto, Forex & commodities and World indices watchlists? Your own lists are kept.", { okText: "Restore" })) {
      for (const d of DEFAULT_LISTS()) if (!this.lists.some((l) => l.name === d.name)) this.lists.push(d);
    }
    if (!a) return;
    this.save();
    this.render();
    bus.emit("watch-symbols");
  }

  renderRows() {
    const rows = this.el.querySelector(".wl-rows");
    if (!rows) return;
    let collapsed = false;
    rows.innerHTML = this.active.items.map((it, idx) => {
      if (it.t === "sec") {
        collapsed = it.collapsed;
        return `<div class="wl-sec" draggable="true" data-idx="${idx}"><span class="caret">${it.collapsed ? "▸" : "▾"}</span>${esc(it.title)}<button class="x" data-del="${idx}" title="Remove section">✕</button></div>`;
      }
      if (collapsed) return "";
      const q = this.quotes[it.s];
      const ok = q && !q.error && q.price != null;
      const ch = ok && q.prevClose ? q.price - q.prevClose : 0, chp = ok && q.prevClose ? (ch / q.prevClose) * 100 : 0;
      const d = ok ? precisionFor(q.price, it.s) : 2;
      return `<div class="wl-row ${it.s === this.current ? "sel" : ""}" draggable="true" data-idx="${idx}" data-sym="${esc(it.s)}" title="${esc(q?.name || it.s)}">
        <span class="sym"><i class="mk ${ok && q.marketOpen ? "open" : ""}"></i>${esc(short(it.s))}</span>
        <span>${ok ? fmtPx(q.price, d) : "…"}</span>
        <span class="${cls(ch)}">${ok ? signed(ch, d) : ""}</span>
        <span class="${cls(ch)}">${ok ? signed(chp) + "%" : ""}</span>
        <button class="x" data-del="${idx}" title="Remove">✕</button>
      </div>`;
    }).join("") || `<div class="empty-note">Empty list. Open a chart and press ＋ to add it.</div>`;
  }

  bindRows() {
    const rows = this.el.querySelector(".wl-rows");
    rows.onclick = (e) => {
      const del = e.target.closest("[data-del]");
      if (del) { this.active.items.splice(+del.dataset.del, 1); this.save(); this.renderRows(); bus.emit("watch-symbols"); return; }
      const s = e.target.closest(".wl-sec");
      if (s) { const it = this.active.items[+s.dataset.idx]; it.collapsed = !it.collapsed; this.save(); this.renderRows(); return; }
      const r = e.target.closest(".wl-row");
      if (r) this.onSelect(r.dataset.sym);
    };
    rows.ondblclick = async (e) => {
      const s = e.target.closest(".wl-sec");
      if (!s) return;
      const it = this.active.items[+s.dataset.idx];
      const t = await askText("Rename section", { label: "Section name", value: it.title, okText: "Rename" });
      if (t) { it.title = t.toUpperCase(); this.save(); this.renderRows(); }
    };
    let dragIdx = null;
    rows.ondragstart = (e) => { dragIdx = +e.target.closest("[data-idx]")?.dataset.idx; e.dataTransfer.effectAllowed = "move"; };
    rows.ondragover = (e) => {
      e.preventDefault();
      rows.querySelectorAll(".drop-above").forEach((x) => x.classList.remove("drop-above"));
      e.target.closest("[data-idx]")?.classList.add("drop-above");
    };
    rows.ondrop = (e) => {
      e.preventDefault();
      const target = e.target.closest("[data-idx]");
      rows.querySelectorAll(".drop-above").forEach((x) => x.classList.remove("drop-above"));
      if (dragIdx == null) return;
      const items = this.active.items;
      const [moved] = items.splice(dragIdx, 1);
      let to = target ? +target.dataset.idx : items.length;
      if (target && dragIdx < +target.dataset.idx) to -= 1;
      items.splice(to, 0, moved);
      dragIdx = null;
      this.save();
      this.renderRows();
    };
  }
}
