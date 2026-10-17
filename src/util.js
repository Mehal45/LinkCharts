// Shared helpers: DOM, API, storage, events, formatting, notifications.

export const $ = (id) => document.getElementById(id);
export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const uid = () => Math.random().toString(36).slice(2, 10);

export async function api(path, opts) {
  const res = await fetch(path, opts && {
    method: opts.method || "POST",
    headers: { "Content-Type": "application/json" },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

/** localStorage with JSON + graceful failure (private mode, quota). */
export const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem("bz:" + key); return v == null ? fallback : JSON.parse(v); } catch { return fallback; }
  },
  set(key, value) {
    try {
      localStorage.setItem("bz:" + key, JSON.stringify(value));
      localStorage.setItem(SAVED_AT, String(Date.now()));
    } catch { /* not persisted in the browser; the disk copy below still runs */ }
    scheduleDiskSave();
  },
};

// ---------------- saving to disk ----------------
// The browser copy is a fast cache; the real copy lives in market-app/data/userdata.json on this PC,
// so data survives cleared browser data, private windows and switching browsers.

export const SAVED_AT = "bz:__savedAt";
let saveTimer = null;

/** All of LinkCharts' saved keys as { "bz:key": "json" }. */
export function snapshot() {
  const items = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k.startsWith("bz:") && k !== SAVED_AT) items[k] = localStorage.getItem(k);
    }
  } catch { /* storage unavailable */ }
  return { savedAt: +(localStorage.getItem(SAVED_AT) || Date.now()), items };
}

function scheduleDiskSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveToDisk, 800); // batch bursts of changes (e.g. dragging a drawing)
}

export async function saveToDisk() {
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await fetch("/api/userdata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot()) });
  } catch { /* server not reachable right now; the next change will try again */ }
}

// Don't lose the last second of changes when the tab closes.
addEventListener("pagehide", () => {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  navigator.sendBeacon?.("/api/userdata", new Blob([JSON.stringify(snapshot())], { type: "application/json" }));
});

/** Tiny pub/sub used to decouple panels from the chart. */
const handlers = {};
export const bus = {
  on(ev, fn) { (handlers[ev] ??= []).push(fn); return () => (handlers[ev] = handlers[ev].filter((f) => f !== fn)); },
  emit(ev, data) { (handlers[ev] || []).forEach((fn) => fn(data)); },
};

// ---------------- names & formatting ----------------

export const FRIENDLY = {
  "^NSEI": "NIFTY 50", "^BSESN": "SENSEX", "^NSEBANK": "BANK NIFTY", "^CNXIT": "NIFTY IT",
  "^GSPC": "S&P 500", "^DJI": "DOW 30", "^IXIC": "NASDAQ", "^NDX": "NASDAQ 100", "^RUT": "RUSSELL 2000", "^VIX": "VIX",
  "^FTSE": "FTSE 100", "^GDAXI": "DAX", "^FCHI": "CAC 40", "^N225": "NIKKEI 225", "^HSI": "HANG SENG", "000001.SS": "SHANGHAI",
  "GC=F": "GOLD", "SI=F": "SILVER", "CL=F": "CRUDE OIL", "NG=F": "NATURAL GAS", "HG=F": "COPPER",
  "DX-Y.NYB": "US DOLLAR INDEX",
};
export const short = (s) => FRIENDLY[s] || s.replace(/\.(NS|BO)$/, "").replace(/=X$/, "").replace(/-USD$/, "USD");

const SYMBOL = { INR: "₹", USD: "$", EUR: "€", GBP: "£", JPY: "¥", GBp: "p", HKD: "HK$", CNY: "¥", USDT: "₮" };
export const currencySymbol = (c) => SYMBOL[c] ?? (c ? c + " " : "");

/** Decimal places that suit a price's magnitude (forex and small coins need more). */
export function precisionFor(price, symbol = "") {
  if (/=X$/.test(symbol)) return price > 20 ? 3 : 5;
  const p = Math.abs(price || 0);
  if (p >= 1) return 2;
  if (p >= 0.01) return 4;
  return 6;
}

export function fmtPx(v, digits) {
  if (v == null || Number.isNaN(v)) return "—";
  const d = digits ?? precisionFor(v);
  return v.toLocaleString("en-IN", { minimumFractionDigits: d, maximumFractionDigits: d });
}

export function fmtVol(v, currency) {
  if (v == null || v === 0) return "—";
  if (currency === "INR") {
    if (v >= 1e7) return (v / 1e7).toFixed(2) + " Cr";
    if (v >= 1e5) return (v / 1e5).toFixed(2) + " L";
  } else {
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
  }
  if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
  return String(Math.round(v * 100) / 100);
}

export function fmtMoney(v, currency) {
  if (v == null || Number.isNaN(v)) return "—";
  const sign = v < 0 ? "−" : "";
  return sign + currencySymbol(currency) + Math.abs(v).toLocaleString(currency === "INR" ? "en-IN" : "en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

export const signed = (v, digits = 2) => (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits);
export const cls = (v) => (v > 0 ? "up" : v < 0 ? "down" : "muted");

export function fmtTime(unix, tz) {
  return new Date(unix * 1000).toLocaleString("en-IN", { timeZone: tz || undefined, dateStyle: "medium", timeStyle: "short" });
}

// ---------------- toasts, sound, notifications ----------------

export function toast(msg, kind = "") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = msg;
  $("toasts").appendChild(el);
  setTimeout(() => el.classList.add("out"), 3200);
  setTimeout(() => el.remove(), 3700);
}

let audioCtx;
export function beep() {
  try {
    audioCtx ??= new AudioContext();
    const t = audioCtx.currentTime;
    for (const [i, f] of [[0, 880], [0.18, 1175]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + i);
      g.gain.exponentialRampToValueAtTime(0.2, t + i + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + i + 0.16);
      o.connect(g).connect(audioCtx.destination);
      o.start(t + i);
      o.stop(t + i + 0.18);
    }
  } catch { /* audio unavailable */ }
}

export function notify(title, body) {
  try {
    if ("Notification" in window && Notification.permission === "granted") new Notification(title, { body });
  } catch { /* notifications unavailable */ }
}

export function modal(title, html, { wide = false } = {}) {
  const bg = document.createElement("div");
  bg.className = "modal-bg";
  bg.innerHTML = `<div class="modal ${wide ? "wide" : ""}"><div class="modal-head"><h3>${esc(title)}</h3><button class="icon" data-close>✕</button></div><div class="modal-body">${html}</div></div>`;
  const close = () => bg.remove();
  bg.addEventListener("pointerdown", (e) => { if (e.target === bg) close(); });
  bg.querySelector("[data-close]").onclick = close;
  document.body.appendChild(bg);
  return { el: bg.querySelector(".modal-body"), close };
}

/**
 * In-app replacement for prompt(): resolves to the trimmed text, or null if cancelled.
 * Enter confirms, Esc or clicking outside cancels.
 */
export function askText(title, { label = "", value = "", placeholder = "", okText = "Save" } = {}) {
  return new Promise((resolve) => {
    const m = modal(title, `
      <label class="field"><span>${esc(label)}</span><input class="ask-input" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="80" /></label>
      <div class="row-end"><button data-ask="cancel">Cancel</button><button class="primary" data-ask="ok">${esc(okText)}</button></div>`);
    const input = m.el.querySelector(".ask-input");
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    m.el.querySelector('[data-ask="ok"]').onclick = () => finish(input.value.trim() || null);
    m.el.querySelector('[data-ask="cancel"]').onclick = () => finish(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") finish(input.value.trim() || null);
      if (e.key === "Escape") finish(null);
      e.stopPropagation(); // keep chart shortcuts from firing while typing
    };
    watchClose(m, () => finish(null));
    setTimeout(() => { input.focus(); input.select(); }, 0);
  });
}

/** In-app replacement for confirm(): resolves true/false. `danger` styles the OK button red. */
export function askConfirm(title, message, { okText = "OK", danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal(title, `<p class="ask-msg">${esc(message)}</p>
      <div class="row-end"><button data-ask="cancel">Cancel</button><button class="primary ${danger ? "danger-solid" : ""}" data-ask="ok">${esc(okText)}</button></div>`);
    let done = false;
    const finish = (v) => { if (done) return; done = true; m.close(); resolve(v); };
    const ok = m.el.querySelector('[data-ask="ok"]');
    ok.onclick = () => finish(true);
    m.el.querySelector('[data-ask="cancel"]').onclick = () => finish(false);
    m.el.closest(".modal").addEventListener("keydown", (e) => { if (e.key === "Escape") finish(false); if (e.key === "Enter") finish(true); e.stopPropagation(); });
    watchClose(m, () => finish(false));
    setTimeout(() => ok.focus(), 0);
  });
}

/** Resolves a pending dialog when it's closed some other way (✕ button or clicking outside). */
function watchClose(m, onClose) {
  const bg = m.el.closest(".modal-bg");
  new MutationObserver((_, obs) => { if (!bg.isConnected) { obs.disconnect(); onClose(); } }).observe(document.body, { childList: true });
}
