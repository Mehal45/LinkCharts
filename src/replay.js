// Bar replay: hide the future, then reveal bars one at a time (step or auto-play).
// Emits "replay-bar" for each revealed bar so paper orders fill against historical prices.
import { bus, fmtTime, toast } from "./util.js";

const SPEEDS = [[1000, "1×"], [500, "2×"], [250, "4×"], [100, "10×"], [40, "25×"]];

export class Replay {
  constructor({ view, bar, onExit }) {
    this.view = view;
    this.barEl = bar;
    this.onExit = onExit;
    this.state = "off"; // off | picking | active
    this.full = [];
    this.index = 0;
    this.timer = null;
    this.speed = 500;
    this.pickLine = null;
    view.mainPane.addEventListener("pointermove", (e) => this.onPickMove(e), true);
    view.mainPane.addEventListener("pointerdown", (e) => this.onPickDown(e), true);
  }

  get active() { return this.state === "active"; }
  get currentBar() { return this.active ? this.full[this.index] : null; }
  get time() { return this.currentBar?.time ?? null; }

  /** Enter "pick a start bar" mode. */
  start() {
    if (!this.view.candles.length) return;
    if (this.state === "active") this.pause();
    if (this.state !== "active") this.full = this.view.candles.slice();
    this.state = "picking";
    this.view.mainPane.classList.add("replay-picking");
    this.renderBar();
    bus.emit("replay-mode", this.state);
  }

  onPickMove(e) {
    if (this.state !== "picking") return;
    const r = this.view.mainPane.getBoundingClientRect();
    const x = e.clientX - r.left;
    if (!this.pickLine) {
      this.pickLine = document.createElement("div");
      this.pickLine.className = "replay-pick";
      this.view.mainPane.appendChild(this.pickLine);
    }
    this.pickLine.style.left = x + "px";
  }

  onPickDown(e) {
    if (this.state !== "picking" || e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    const r = this.view.mainPane.getBoundingClientRect();
    const t = this.view.xToTime(e.clientX - r.left);
    // Cut at the last bar at or before the clicked time; keep enough history for indicators.
    let i = this.full.findIndex((c) => c.time > t) - 1;
    if (i < 0) i = t < this.full[0].time ? 0 : this.full.length - 1;
    this.begin(Math.max(1, Math.min(i, this.full.length - 2)));
  }

  begin(index) {
    this.index = index;
    this.state = "active";
    this.pickLine?.remove();
    this.pickLine = null;
    this.view.mainPane.classList.remove("replay-picking");
    this.view.setData(this.full.slice(0, index + 1), null);
    this.view.showTail(120);
    this.renderBar();
    bus.emit("replay-mode", this.state);
    bus.emit("replay-bar", { symbol: this.view.meta.symbol, bar: this.full[index], replayStart: true });
  }

  /** Re-cut at the same time after the interval/symbol data was reloaded. */
  reload(candles) {
    if (!this.active) return false;
    const t = this.time;
    this.full = candles;
    let i = candles.findIndex((c) => c.time > t) - 1;
    if (i < 1) i = 1;
    this.index = Math.min(i, candles.length - 1);
    this.view.setData(candles.slice(0, this.index + 1), null);
    this.view.showTail(120);
    this.renderBar();
    return true;
  }

  step() {
    if (!this.active) return;
    if (this.index >= this.full.length - 1) { this.pause(); toast("Replay reached the latest bar"); return; }
    this.index++;
    const bar = this.full[this.index];
    this.view.mergeTail([bar]);
    bus.emit("replay-bar", { symbol: this.view.meta.symbol, bar });
    this.renderBar();
  }

  play() {
    if (!this.active || this.timer) return;
    this.timer = setInterval(() => this.step(), this.speed);
    this.renderBar();
  }

  pause() {
    clearInterval(this.timer);
    this.timer = null;
    this.renderBar();
  }

  toggle() { this.timer ? this.pause() : this.play(); }

  setSpeed(ms) {
    this.speed = ms;
    if (this.timer) { this.pause(); this.play(); }
  }

  exit() {
    this.pause();
    this.pickLine?.remove();
    this.pickLine = null;
    this.view.mainPane.classList.remove("replay-picking");
    this.state = "off";
    this.renderBar();
    bus.emit("replay-mode", this.state);
    this.onExit();
  }

  renderBar() {
    const el = this.barEl;
    if (this.state === "off") { el.hidden = true; return; }
    el.hidden = false;
    if (this.state === "picking") {
      el.innerHTML = `<span>⏪ <b>Bar replay</b> — click on the chart where the replay should start</span><button data-r="exit">Cancel</button>`;
    } else {
      const bar = this.currentBar;
      el.innerHTML = `
        <span class="badge replay">⏪ Replay</span>
        <button data-r="pick" title="Pick a new start point">⇤ Select bar</button>
        <button data-r="toggle" class="primary" title="Play / pause (Shift+Space)">${this.timer ? "❚❚ Pause" : "▶ Play"}</button>
        <button data-r="step" title="Next bar (Shift+→)">⏭ Step</button>
        <select data-r="speed" title="Speed">${SPEEDS.map(([ms, l]) => `<option value="${ms}" ${ms === this.speed ? "selected" : ""}>${l}</option>`).join("")}</select>
        <span class="muted">${bar ? fmtTime(bar.time, this.view.meta?.timezone) : ""} · bar ${this.index + 1}/${this.full.length}</span>
        <span class="spacer"></span>
        <button data-r="exit" title="Back to real-time">✕ Exit replay</button>`;
    }
    el.onclick = (e) => {
      const r = e.target.closest("[data-r]")?.dataset.r;
      if (r === "exit") this.exit();
      if (r === "pick") this.start();
      if (r === "toggle") this.toggle();
      if (r === "step") this.step();
    };
    el.onchange = (e) => { if (e.target.dataset.r === "speed") this.setSpeed(+e.target.value); };
  }
}

export const isReplayKey = (e) => e.shiftKey && (e.key === "ArrowRight" || e.code === "Space");
