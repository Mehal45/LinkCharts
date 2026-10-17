// Drawing tools rendered as a Lightweight Charts series primitive, so they pan/zoom with the chart.
// A drawing is { id, type, points: [{ time, price }], color, width, text? }, stored per symbol.
import { store, uid, bus, fmtPx, esc, precisionFor, askText, askConfirm } from "./util.js";

export const TOOLS = [
  { id: "cursor", icon: "↖", label: "Cursor", key: "" },
  { id: "trend", icon: "╱", label: "Trend line", key: "Alt+T", points: 2 },
  { id: "ray", icon: "↗", label: "Ray", key: "", points: 2 },
  { id: "extended", icon: "⟋", label: "Extended line", key: "", points: 2 },
  { id: "hline", icon: "―", label: "Horizontal line", key: "Alt+H", points: 1 },
  { id: "hray", icon: "⟶", label: "Horizontal ray", key: "Alt+J", points: 1 },
  { id: "vline", icon: "│", label: "Vertical line", key: "Alt+V", points: 1 },
  { id: "rect", icon: "▭", label: "Rectangle", key: "Alt+Shift+R", points: 2 },
  { id: "fib", icon: "≣", label: "Fib retracement", key: "Alt+F", points: 2 },
  { id: "text", icon: "T", label: "Text note", key: "", points: 1 },
];
const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1];
const FIB_COLORS = ["#868e96", "#f03e3e", "#fd7e14", "#40c057", "#15aabf", "#4c6ef5", "#868e96"];
const DEFAULT_COLOR = { trend: "#2962ff", ray: "#2962ff", extended: "#2962ff", hline: "#f7c948", hray: "#f7c948", vline: "#9aa1ac", rect: "#7c8cff", fib: "#868e96", text: "#e6e8eb" };

export const drawingPrefs = { magnet: store.get("magnet", false), keepTool: false };

/** Renders the shared left toolbar; actions go to whichever chart's Drawings is active. */
export function renderDrawToolbar(el, getActive) {
  const d = getActive();
  el.innerHTML = TOOLS.map((t) => `<button class="tool ${t.id === d.tool ? "on" : ""}" data-tool="${t.id}" title="${t.label}${t.key ? " (" + t.key + ")" : ""}">${t.icon}</button>`).join("")
    + `<span class="tool-sep"></span>
    <button class="tool ${drawingPrefs.magnet ? "on" : ""}" data-act="magnet" title="Magnet: snap to candle open/high/low/close">🧲</button>
    <button class="tool ${drawingPrefs.keepTool ? "on" : ""}" data-act="keep" title="Keep drawing tool selected after use">🔒</button>
    <button class="tool" data-act="clear" title="Remove all drawings on this chart's symbol">🗑</button>`;
  el.onclick = (e) => {
    const b = e.target.closest("button");
    if (!b) return;
    const active = getActive();
    if (b.dataset.tool) active.setTool(b.dataset.tool);
    if (b.dataset.act === "magnet") { drawingPrefs.magnet = !drawingPrefs.magnet; store.set("magnet", drawingPrefs.magnet); }
    if (b.dataset.act === "keep") drawingPrefs.keepTool = !drawingPrefs.keepTool;
    if (b.dataset.act === "clear") active.clearAll();
    renderDrawToolbar(el, getActive);
  };
}

class DrawingsPrimitive {
  constructor(ctrl) {
    this.ctrl = ctrl;
    this.views = [{
      zOrder: () => "top",
      renderer: () => ({ draw: (target) => target.useMediaCoordinateSpace(({ context, mediaSize }) => ctrl.draw(context, mediaSize)) }),
    }];
  }
  attached({ requestUpdate }) { this.requestUpdate = requestUpdate; }
  detached() { this.requestUpdate = null; }
  updateAllViews() {}
  paneViews() { return this.views; }
}

export class Drawings {
  constructor(view, { floating, onToolChange }) {
    this.view = view;
    this.onToolChange = onToolChange;
    this.floatEl = floating;
    this.symbol = null;
    this.items = [];
    this.tool = "cursor";
    this.selected = null;
    this.placing = null; // { drawing, awaitingClick }
    this.primitive = new DrawingsPrimitive(this);
    this.attach(view.price);
    // Only follow this chart's own price series (several charts can be on screen).
    this.offSeries = bus.on("price-series", ({ series, view: v }) => { if (v === this.view) this.attach(series); });
    this.offSaved = bus.on("drawings-saved", ({ symbol, from }) => {
      if (from !== this && symbol === this.symbol) { this.items = store.get(`drawings:${symbol}`, []); this.redraw(); }
    });
    this.bindPointer();
  }

  attach(series) {
    if (this.series) try { this.series.detachPrimitive(this.primitive); } catch { /* old series removed */ }
    this.series = series;
    series.attachPrimitive(this.primitive);
  }

  setSymbol(symbol) {
    this.symbol = symbol;
    this.items = store.get(`drawings:${symbol}`, []);
    this.select(null);
    this.redraw();
  }

  save() {
    store.set(`drawings:${this.symbol}`, this.items);
    bus.emit("drawings-saved", { symbol: this.symbol, from: this }); // other charts on the same symbol follow
  }
  redraw() { this.primitive.requestUpdate?.(); }

  // Magnet and "keep tool" are shared by every chart on screen.
  get magnet() { return drawingPrefs.magnet; }
  get keepTool() { return drawingPrefs.keepTool; }

  async clearAll() {
    if (!this.items.length) return;
    if (!(await askConfirm("Remove drawings", `Remove all ${this.items.length} drawings on this symbol?`, { okText: "Remove all", danger: true }))) return;
    this.items = []; this.select(null); this.save(); this.redraw();
  }

  dispose() {
    this.offSeries?.();
    this.offSaved?.();
    try { this.series?.detachPrimitive(this.primitive); } catch { /* chart already removed */ }
  }

  setTool(tool) {
    this.tool = tool;
    this.placing = null;
    this.view.chart.applyOptions({ handleScroll: tool === "cursor", handleScale: tool === "cursor" });
    this.view.mainPane.classList.toggle("drawing-mode", tool !== "cursor");
    this.onToolChange?.(tool);
    this.redraw();
  }

  // ---------------- pointer interaction ----------------

  local(e) {
    const r = this.view.mainPane.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  toPoint({ x, y }) {
    let time = this.view.xToTime(x), price = this.view.yToPrice(y);
    if (this.magnet && time != null) {
      const i = Math.round(this.view.timeToLogical(time));
      const bar = this.view.candles[i];
      if (bar) {
        time = bar.time;
        const ohlc = [bar.open, bar.high, bar.low, bar.close];
        price = ohlc.reduce((best, p) => (Math.abs(this.view.priceToY(p) - y) < Math.abs(this.view.priceToY(best) - y) ? p : best), ohlc[0]);
      }
    }
    return time == null || price == null ? null : { time, price };
  }

  bindPointer() {
    const el = this.view.mainPane;
    el.addEventListener("pointerdown", (e) => this.onDown(e), true);
    el.addEventListener("pointermove", (e) => this.onHover(e), true);
    el.addEventListener("dblclick", (e) => {
      const hit = this.hitTest(this.local(e));
      if (hit?.d.type === "text") { e.stopPropagation(); this.editText(hit.d); }
    }, true);
  }

  onDown(e) {
    if (e.button !== 0 || e.target.closest(".float-bar, .legend, .replay-pick")) return;
    const pos = this.local(e);
    if (pos.x > this.view.paneWidth()) return; // price axis

    if (this.placing?.awaitingClick) {
      e.stopPropagation(); e.preventDefault();
      const p = this.toPoint(pos);
      if (p) this.placing.drawing.points[1] = p;
      this.finishPlacing();
      return;
    }

    if (this.tool !== "cursor") {
      e.stopPropagation(); e.preventDefault();
      const p = this.toPoint(pos);
      if (!p) return;
      const def = TOOLS.find((t) => t.id === this.tool);
      const d = { id: uid(), type: this.tool, points: def.points === 2 ? [p, { ...p }] : [p], color: DEFAULT_COLOR[this.tool], width: 2 };
      if (d.type === "text") {
        // Ask for the note in an in-app dialog, then place it where the user clicked.
        askText("Text note", { label: "Note", placeholder: "e.g. Breakout level", okText: "Add note" }).then((text) => {
          if (!text) return;
          d.text = text;
          this.items.push(d);
          this.placing = { drawing: d };
          this.finishPlacing();
        });
        return;
      }
      this.items.push(d);
      if (def.points === 1) { this.placing = { drawing: d }; this.finishPlacing(); return; }
      this.placing = { drawing: d, start: pos };
      this.dragLoop(e, (p2) => { d.points[1] = p2; }, (endPos) => {
        if (Math.hypot(endPos.x - pos.x, endPos.y - pos.y) < 5) this.placing.awaitingClick = true; // click-click mode
        else this.finishPlacing();
      });
      return;
    }

    // Cursor tool: grab a handle or a drawing; otherwise let the chart pan.
    const sel = this.selected && this.items.find((d) => d.id === this.selected);
    const handle = sel && this.handleAt(sel, pos);
    if (handle != null) {
      e.stopPropagation(); e.preventDefault();
      this.dragLoop(e, (p) => { this.movePoint(sel, handle, p); }, () => this.save());
      return;
    }
    const hit = this.hitTest(pos);
    if (hit) {
      e.stopPropagation(); e.preventDefault();
      this.select(hit.d.id);
      const start = this.toPoint(pos);
      const orig = hit.d.points.map((p) => ({ ...p }));
      const l0 = this.view.timeToLogical(start.time);
      this.dragLoop(e, (p) => {
        const dl = this.view.timeToLogical(p.time) - l0, dp = p.price - start.price;
        hit.d.points = orig.map((o) => ({ time: this.view.logicalToTime(this.view.timeToLogical(o.time) + dl), price: o.price + dp }));
      }, () => this.save());
      return;
    }
    if (this.selected) this.select(null);
  }

  onHover(e) {
    const pos = this.local(e);
    if (this.placing?.awaitingClick) {
      const p = this.toPoint(pos);
      if (p) { this.placing.drawing.points[1] = p; this.redraw(); }
      return;
    }
    if (this.tool === "cursor") {
      const sel = this.selected && this.items.find((d) => d.id === this.selected);
      const over = (sel && this.handleAt(sel, pos) != null) ? "grab" : this.hitTest(pos) ? "pointer" : "";
      this.view.mainPane.style.cursor = over;
    }
  }

  dragLoop(e, onMove, onUp) {
    const move = (ev) => {
      const p = this.toPoint(this.local(ev));
      if (p) { onMove(p); this.redraw(); this.positionFloat(); }
    };
    const up = (ev) => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", up, true);
      onUp?.(this.local(ev));
    };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", up, true);
  }

  finishPlacing() {
    const d = this.placing.drawing;
    this.placing = null;
    this.save();
    this.select(d.id);
    if (!this.keepTool) this.setTool("cursor");
    this.redraw();
  }

  movePoint(d, index, p) {
    if (d.type === "hline" || d.type === "hray") d.points[0] = { ...d.points[0], price: p.price, ...(d.type === "hray" ? { time: p.time } : {}) };
    else if (d.type === "vline") d.points[0] = { ...d.points[0], time: p.time };
    else d.points[index] = p;
  }

  select(id) {
    this.selected = id;
    this.renderFloat();
    this.redraw();
  }

  deleteSelected() {
    if (!this.selected) return false;
    this.items = this.items.filter((d) => d.id !== this.selected);
    this.select(null);
    this.save();
    return true;
  }

  cancel() {
    if (this.placing) { this.items = this.items.filter((d) => d !== this.placing.drawing); this.placing = null; this.redraw(); }
    if (this.tool !== "cursor") this.setTool("cursor");
    else this.select(null);
  }

  async editText(d) {
    const t = await askText("Edit note", { label: "Note", value: d.text, okText: "Save" });
    if (t) { d.text = t; this.save(); this.redraw(); }
  }

  // ---------------- floating properties bar ----------------

  renderFloat() {
    const d = this.selected && this.items.find((x) => x.id === this.selected);
    if (!d) { this.floatEl.hidden = true; return; }
    this.floatEl.hidden = false;
    const name = TOOLS.find((t) => t.id === d.type)?.label;
    this.floatEl.innerHTML = `<span class="muted">${esc(name)}</span>
      <input type="color" value="${d.color}" title="Color" data-f="color" />
      <select data-f="width" title="Line width">${[1, 2, 3, 4].map((w) => `<option ${w === d.width ? "selected" : ""} value="${w}">${w}px</option>`).join("")}</select>
      ${d.type === "text" ? `<button data-f="edit">Edit text</button>` : ""}
      ${d.type === "hline" || d.type === "hray" ? `<button data-f="alert" title="Create a price alert at this level">🔔 Alert</button>` : ""}
      <button data-f="clone" title="Clone">⧉</button>
      <button data-f="delete" title="Delete (Del)">🗑</button>`;
    this.floatEl.oninput = (e) => {
      const f = e.target.dataset.f;
      if (f === "color") d.color = e.target.value;
      if (f === "width") d.width = +e.target.value;
      this.save(); this.redraw();
    };
    this.floatEl.onclick = (e) => {
      const f = e.target.closest("button")?.dataset.f;
      if (f === "delete") this.deleteSelected();
      if (f === "edit") this.editText(d);
      if (f === "alert") bus.emit("create-alert", { price: d.points[0].price });
      if (f === "clone") {
        const step = this.view.barSeconds() * 5;
        const c = { ...structuredClone(d), id: uid(), points: d.points.map((p) => ({ time: p.time + step, price: p.price })) };
        this.items.push(c); this.save(); this.select(c.id);
      }
    };
    this.positionFloat();
  }

  positionFloat() {
    if (this.floatEl.hidden) return;
    this.floatEl.style.left = "50%";
    this.floatEl.style.top = "8px";
  }

  // ---------------- geometry ----------------

  screen(d) {
    return d.points.map((p) => ({ x: this.view.timeToX(p.time), y: this.view.priceToY(p.price) }));
  }

  /** Extends segment a→b to the pane edges (forward only for rays). */
  extend(a, b, w, h, both) {
    const dx = b.x - a.x, dy = b.y - a.y;
    if (Math.abs(dx) < 1e-6 && Math.abs(dy) < 1e-6) return [a, b];
    const far = 4 * (w + h);
    const len = Math.hypot(dx, dy);
    const ux = dx / len, uy = dy / len;
    const end = { x: a.x + ux * far, y: a.y + uy * far };
    const start = both ? { x: a.x - ux * far, y: a.y - uy * far } : a;
    return [start, end];
  }

  handleAt(d, pos) {
    const pts = this.screen(d);
    if (d.type === "hline") return Math.abs(pos.y - pts[0].y) < 6 && Math.abs(pos.x - this.view.paneWidth() / 2) < 8 ? 0 : null;
    if (d.type === "vline") return Math.abs(pos.x - pts[0].x) < 6 && Math.abs(pos.y - 20) < 8 ? 0 : null;
    const i = pts.findIndex((p) => p.x != null && p.y != null && Math.hypot(p.x - pos.x, p.y - pos.y) < 8);
    return i >= 0 ? i : null;
  }

  hitTest(pos) {
    const w = this.view.paneWidth(), h = this.view.mainPane.clientHeight;
    for (let k = this.items.length - 1; k >= 0; k--) {
      const d = this.items[k], p = this.screen(d);
      if (p.some((q) => q.x == null || q.y == null)) continue;
      const near = (a, b) => distToSegment(pos, a, b) < 6;
      let hit = false;
      switch (d.type) {
        case "trend": hit = near(p[0], p[1]); break;
        case "ray": { const [a, b] = this.extend(p[0], p[1], w, h, false); hit = near(a, b); break; }
        case "extended": { const [a, b] = this.extend(p[0], p[1], w, h, true); hit = near(a, b); break; }
        case "hline": hit = Math.abs(pos.y - p[0].y) < 6; break;
        case "hray": hit = Math.abs(pos.y - p[0].y) < 6 && pos.x >= p[0].x - 6; break;
        case "vline": hit = Math.abs(pos.x - p[0].x) < 6; break;
        case "rect": {
          const x1 = Math.min(p[0].x, p[1].x), x2 = Math.max(p[0].x, p[1].x), y1 = Math.min(p[0].y, p[1].y), y2 = Math.max(p[0].y, p[1].y);
          hit = pos.x >= x1 - 5 && pos.x <= x2 + 5 && pos.y >= y1 - 5 && pos.y <= y2 + 5;
          break;
        }
        case "fib": {
          const x1 = Math.min(p[0].x, p[1].x), x2 = Math.max(p[0].x, p[1].x);
          hit = pos.x >= x1 - 5 && pos.x <= x2 + 5 && FIB_LEVELS.some((lv) => Math.abs(pos.y - (p[1].y + (p[0].y - p[1].y) * lv)) < 6);
          break;
        }
        case "text": hit = pos.x >= p[0].x - 4 && pos.x <= p[0].x + (d._w || 60) + 4 && pos.y >= p[0].y - 18 && pos.y <= p[0].y + 6; break;
      }
      if (hit) return { d };
    }
    return null;
  }

  // ---------------- rendering ----------------

  draw(ctx, size) {
    const w = this.view.paneWidth(), h = size.height;
    const digits = precisionFor(this.view.candles[this.view.candles.length - 1]?.close ?? 1, this.view.meta?.symbol);
    for (const d of this.items) {
      const p = this.screen(d);
      if (p.some((q) => q.x == null && d.type !== "hline" || q.y == null && d.type !== "vline")) continue;
      const selected = d.id === this.selected;
      ctx.save();
      ctx.strokeStyle = d.color;
      ctx.fillStyle = d.color;
      ctx.lineWidth = d.width;
      const line = (a, b) => { ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); };
      const tag = (y, text) => {
        ctx.font = "11px Inter, sans-serif";
        const tw = ctx.measureText(text).width + 10;
        ctx.fillStyle = d.color;
        ctx.fillRect(w - tw - 2, y - 9, tw, 18);
        ctx.fillStyle = "#0f1115";
        ctx.fillText(text, w - tw + 3, y + 4);
      };
      switch (d.type) {
        case "trend": line(p[0], p[1]); break;
        case "ray": { const [a, b] = this.extend(p[0], p[1], w, h, false); line(a, b); break; }
        case "extended": { const [a, b] = this.extend(p[0], p[1], w, h, true); line(a, b); break; }
        case "hline": line({ x: 0, y: p[0].y }, { x: w, y: p[0].y }); tag(p[0].y, fmtPx(d.points[0].price, digits)); break;
        case "hray": line(p[0], { x: w, y: p[0].y }); tag(p[0].y, fmtPx(d.points[0].price, digits)); break;
        case "vline": line({ x: p[0].x, y: 0 }, { x: p[0].x, y: h }); break;
        case "rect": {
          const x = Math.min(p[0].x, p[1].x), y = Math.min(p[0].y, p[1].y), rw = Math.abs(p[1].x - p[0].x), rh = Math.abs(p[1].y - p[0].y);
          ctx.globalAlpha = 0.15; ctx.fillRect(x, y, rw, rh);
          ctx.globalAlpha = 1; ctx.strokeRect(x, y, rw, rh);
          break;
        }
        case "fib": {
          const x1 = Math.min(p[0].x, p[1].x), x2 = Math.max(p[0].x, p[1].x);
          ctx.lineWidth = 1;
          ctx.font = "11px Inter, sans-serif";
          FIB_LEVELS.forEach((lv, i) => {
            const y = p[1].y + (p[0].y - p[1].y) * lv;
            const price = d.points[1].price + (d.points[0].price - d.points[1].price) * lv;
            if (i > 0) {
              const yPrev = p[1].y + (p[0].y - p[1].y) * FIB_LEVELS[i - 1];
              ctx.globalAlpha = 0.08; ctx.fillStyle = FIB_COLORS[i]; ctx.fillRect(x1, Math.min(y, yPrev), x2 - x1, Math.abs(y - yPrev));
            }
            ctx.globalAlpha = 1; ctx.strokeStyle = FIB_COLORS[i]; ctx.fillStyle = FIB_COLORS[i];
            line({ x: x1, y }, { x: x2, y });
            ctx.fillText(`${lv} (${fmtPx(price, digits)})`, x1 + 4, y - 3);
          });
          ctx.strokeStyle = d.color; ctx.setLineDash([4, 4]); line(p[0], p[1]); ctx.setLineDash([]);
          break;
        }
        case "text": {
          ctx.font = "600 13px Inter, sans-serif";
          d._w = ctx.measureText(d.text).width;
          ctx.globalAlpha = 0.75; ctx.fillStyle = "#161a20"; ctx.fillRect(p[0].x - 4, p[0].y - 16, d._w + 8, 22);
          ctx.globalAlpha = 1; ctx.fillStyle = d.color; ctx.fillText(d.text, p[0].x, p[0].y);
          break;
        }
      }
      if (selected) {
        ctx.fillStyle = "#0f1115"; ctx.strokeStyle = "#2962ff"; ctx.lineWidth = 2;
        const handles = d.type === "hline" ? [{ x: w / 2, y: p[0].y }] : d.type === "vline" ? [{ x: p[0].x, y: 20 }] : p;
        for (const q of handles) { ctx.beginPath(); ctx.arc(q.x, q.y, 5, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); }
      }
      ctx.restore();
    }
  }
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x, dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}
