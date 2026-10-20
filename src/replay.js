// Bar replay: hide the future, then reveal bars one at a time (step or auto-play).
// Emits "replay-bar" for each revealed bar so paper orders fill against historical prices.
// When the chart's source can page history (`loader`), the replay isn't limited to the bars on screen:
// going to an earlier date fetches the bars around it, and newer bars are fetched ahead of playback.
import { bus, fmtTime, toast } from "./util.js";

const SPEEDS = [[1000, "1×"], [500, "2×"], [250, "4×"], [100, "10×"], [40, "25×"]];
const PREFETCH = 500; // fetch the next batch when fewer bars than this are left to play

// Chart times are already shifted to the exchange's local time, so they're formatted as UTC.
const fmtBar = (t) => fmtTime(t, "UTC");
/** Index of the last bar at or before `t` (-1 if every bar is later). */
function lastAtOrBefore(bars, t) {
  let lo = 0, hi = bars.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

export class Replay {
  constructor({ view, bar, onExit, loader }) {
    this.view = view;
    this.barEl = bar;
    this.onExit = onExit;
    this.loader = loader; // { enabled(), around(time) → { candles, endReached }, newer(time) → { candles, done } }
    this.state = "off"; // off | picking | active
    this.full = [];
    this.index = 0;
    this.timer = null;
    this.speed = 500;
    this.pickLine = null;
    this.endReached = true; // `full` already runs up to the latest bar
    this.fetching = false;
    this.gen = 0; // bumped whenever `full` is replaced, so late fetches for an old window are dropped
    this.startTime = null;
    view.mainPane.addEventListener("pointermove", (e) => this.onPickMove(e), true);
    view.mainPane.addEventListener("pointerdown", (e) => this.onPickDown(e), true);
  }

  get active() { return this.state === "active"; }
  get currentBar() { return this.active ? this.full[this.index] : null; }
  get time() { return this.currentBar?.time ?? null; }
  get canFetch() { return !!this.loader?.enabled(); }

  setWindow(full, endReached) {
    this.gen++;
    this.fetching = false;
    this.full = full;
    this.endReached = endReached;
  }

  /** Enter "pick a start bar" mode. */
  start() {
    if (!this.view.candles.length) return;
    if (this.state === "active") this.pause();
    if (this.state !== "active") this.setWindow(this.view.candles.slice(), true);
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

  /**
   * Starts at the last bar at or before `t` (chart time). Dates outside the loaded bars are fetched first;
   * weekends and holidays land on the last session before them.
   */
  async jumpTo(t) {
    if (this.state === "off" || !this.full.length) return;
    const outside = t < this.full[0].time || (t > this.full[this.full.length - 1].time && !this.endReached);
    if (outside && this.canFetch) {
      this.pause();
      this.setWindow(this.full, this.endReached);
      const gen = this.gen;
      this.fetching = true;
      this.renderBar();
      let win;
      try {
        win = await this.loader.around(t);
      } catch (err) {
        if (gen === this.gen) { this.fetching = false; this.renderBar(); }
        toast(`Couldn't load bars for that date: ${err.message}`, "error");
        return;
      }
      if (gen !== this.gen) return;
      this.fetching = false;
      if (win.candles.length < 3) { toast("No bars are available around that date", "error"); this.renderBar(); return; }
      this.setWindow(win.candles, win.endReached);
    }
    const bars = this.full;
    if (bars.length < 3) return;
    let i = lastAtOrBefore(bars, t);
    if (i < 1) toast(`Earliest available bar: ${fmtBar(bars[0].time)}`);
    if (t > bars[bars.length - 1].time) toast("That's after the latest bar; starting at the latest one");
    this.begin(Math.max(1, Math.min(i, bars.length - 2)));
  }

  begin(index) {
    this.index = index;
    this.startTime = this.full[index].time;
    this.state = "active";
    this.pickLine?.remove();
    this.pickLine = null;
    this.view.mainPane.classList.remove("replay-picking");
    this.view.setData(this.full.slice(0, index + 1), null);
    this.view.showTail(120);
    this.renderBar();
    bus.emit("replay-mode", this.state);
    bus.emit("replay-bar", { symbol: this.view.meta.symbol, bar: this.full[index], replayStart: true });
    this.prefetch();
  }

  /** Back to where this replay started. */
  reset() {
    if (!this.active || this.startTime == null) return;
    this.pause();
    this.jumpTo(this.startTime);
  }

  /** Re-cut at the same time after the interval/symbol data was reloaded. */
  reload(candles) {
    if (this.state === "picking") this.setWindow(candles.slice(), true); // pick from the new data
    if (!this.active) return false;
    const t = this.time;
    this.setWindow(candles, true);
    if (t < candles[0].time && this.canFetch) { this.jumpTo(t); return true; } // the new interval's first load doesn't reach back that far
    let i = candles.findIndex((c) => c.time > t) - 1;
    if (i < 1) i = 1;
    this.index = Math.min(i, candles.length - 1);
    this.view.setData(candles.slice(0, this.index + 1), null);
    this.view.showTail(120);
    this.renderBar();
    return true;
  }

  /** Older bars loaded by scrolling back: keep them in the replay window too. */
  prepend(older) {
    const first = this.full[0]?.time ?? Infinity;
    const add = older.filter((c) => c.time < first);
    if (!add.length) return;
    this.full = add.concat(this.full);
    if (this.active) this.index += add.length;
    this.view.prepend(add);
    this.renderStatus();
  }

  prefetch() {
    if (this.active && this.full.length - 1 - this.index < PREFETCH) this.loadNewer();
  }

  /** Appends the next batch of bars after the replay window. */
  async loadNewer() {
    if (this.endReached || this.fetching || !this.canFetch) return;
    const gen = this.gen;
    this.fetching = true;
    this.renderStatus();
    try {
      const r = await this.loader.newer(this.full[this.full.length - 1].time);
      if (gen !== this.gen) return;
      const last = this.full[this.full.length - 1].time;
      const add = r.candles.filter((c) => c.time > last);
      for (const c of add) this.full.push(c);
      if (r.done || !add.length) this.endReached = true;
    } catch (err) {
      if (gen !== this.gen) return;
      this.pause();
      toast(`Couldn't load more bars: ${err.message}`, "error");
    } finally {
      if (gen === this.gen) { this.fetching = false; this.renderStatus(); }
    }
  }

  step() {
    if (!this.active) return;
    if (this.index >= this.full.length - 1) {
      if (!this.endReached && this.canFetch) { this.loadNewer(); return; } // wait for the next batch
      this.pause(); toast("Replay reached the latest bar"); return;
    }
    this.index++;
    const bar = this.full[this.index];
    this.view.mergeTail([bar]);
    bus.emit("replay-bar", { symbol: this.view.meta.symbol, bar });
    this.renderStatus();
    this.prefetch();
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
    this.setWindow([], true);
    this.pickLine?.remove();
    this.pickLine = null;
    this.view.mainPane.classList.remove("replay-picking");
    this.state = "off";
    this.renderBar();
    bus.emit("replay-mode", this.state);
    this.onExit();
  }

  /** Date box for "go to": a date for daily+ bars, a date and time for intraday ones. */
  dateInput() {
    const intraday = this.view.intraday;
    const t = this.currentBar?.time ?? this.full[this.full.length - 1]?.time;
    const value = t != null ? new Date(t * 1000).toISOString().slice(0, intraday ? 16 : 10) : "";
    return `<input data-r="date" type="${intraday ? "datetime-local" : "date"}" value="${value}" title="Replay from this date (exchange time)" />
      <button data-r="go" title="Start the replay at this date">Go</button>`;
  }

  goToInput() {
    const v = this.barEl.querySelector('[data-r="date"]')?.value;
    if (!v) return;
    const [d, tm] = v.split("T");
    const [Y, M, D] = d.split("-").map(Number);
    const [h, m] = (tm || "23:59").split(":").map(Number);
    if (![Y, M, D, h, m].every(Number.isFinite)) return;
    this.jumpTo(Date.UTC(Y, M - 1, D, h, m, tm ? 0 : 59) / 1000); // a date alone means "that day's bar"
  }

  statusText() {
    const bar = this.currentBar;
    if (!bar) return "";
    return `${fmtBar(bar.time)} · bar ${this.index + 1}/${this.full.length}${this.endReached ? "" : "+"}${this.fetching ? " · loading…" : ""}`;
  }

  /** Cheap per-step update (keeps the date box as typed). */
  renderStatus() {
    const s = this.barEl.querySelector(".replay-status");
    if (s) s.textContent = this.statusText();
  }

  renderBar() {
    const el = this.barEl;
    if (this.state === "off") { el.hidden = true; return; }
    el.hidden = false;
    const typed = el.querySelector('[data-r="date"]')?.value;
    if (this.state === "picking") {
      el.innerHTML = `<span>⏪ <b>Bar replay</b> — ${this.fetching ? "loading bars…" : "click on the chart where the replay should start, or pick a date"}</span>
        ${this.dateInput()}<button data-r="exit">Cancel</button>`;
    } else {
      el.innerHTML = `
        <span class="badge replay">⏪ Replay</span>
        <button data-r="pick" title="Pick a new start point">⇤ Select bar</button>
        <button data-r="toggle" class="primary" title="Play / pause (Shift+Space)">${this.timer ? "❚❚ Pause" : "▶ Play"}</button>
        <button data-r="step" title="Next bar (Shift+→)">⏭ Step</button>
        <button data-r="reset" title="Back to the bar this replay started at">↺ Reset</button>
        <select data-r="speed" title="Speed">${SPEEDS.map(([ms, l]) => `<option value="${ms}" ${ms === this.speed ? "selected" : ""}>${l}</option>`).join("")}</select>
        ${this.dateInput()}
        <span class="muted replay-status"></span>
        <span class="spacer"></span>
        <button data-r="exit" title="Back to real-time">✕ Exit replay</button>`;
      this.renderStatus();
    }
    if (typed) el.querySelector('[data-r="date"]').value = typed;
    el.onclick = (e) => {
      const r = e.target.closest("[data-r]")?.dataset.r;
      if (r === "exit") this.exit();
      if (r === "pick") this.start();
      if (r === "toggle") this.toggle();
      if (r === "step") this.step();
      if (r === "reset") this.reset();
      if (r === "go") this.goToInput();
    };
    el.onchange = (e) => { if (e.target.dataset.r === "speed") this.setSpeed(+e.target.value); };
    el.onkeydown = (e) => { if (e.key === "Enter" && e.target.dataset.r === "date") this.goToInput(); };
  }
}

export const isReplayKey = (e) => e.shiftKey && (e.key === "ArrowRight" || e.code === "Space");
