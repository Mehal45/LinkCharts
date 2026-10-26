// In-app updates (desktop app only): a bar when a newer LinkCharts is out, and "App updates" in the
// ⚙ dialog. "Update now" downloads the new installer in the background; "Restart & update" closes
// LinkCharts, installs it and opens the new version. Your data lives outside the app, so it stays.
import { esc } from "./util.js";

const updates = window.linkchartsDesktop?.updates || null;
const SKIP = "linkcharts.skipUpdate";
const AUTO = "linkcharts.autoUpdate";

const state = { phase: "idle", info: null, progress: 0, error: null, hidden: false };
const listeners = new Set();
const set = (patch) => { Object.assign(state, patch); listeners.forEach((fn) => fn()); };
const pct = () => `${Math.round((state.progress || 0) * 100)}%`;
const autoOn = () => { try { return localStorage.getItem(AUTO) !== "0"; } catch { return true; } };
/** Release notes without the download instructions GitHub shows on the release page. */
const notesOf = (info) => (info?.notes || "").split(/^## Download/m)[0].replace(/\r/g, "").trim();

export async function checkForUpdates(manual = false) {
  if (!updates || ["checking", "downloading", "installing"].includes(state.phase)) return;
  set({ phase: "checking", error: null });
  try {
    const info = await updates.check();
    let skipped = null;
    try { skipped = localStorage.getItem(SKIP); } catch { /* ignore */ }
    if (!info.available) set({ phase: "latest", info });
    else set({ phase: state.ready === info.version ? "ready" : "available", info, hidden: !manual && skipped === info.version });
  } catch (e) {
    set({ phase: manual ? "error" : "idle", error: String(e?.message || e) });
  }
}

async function download() {
  if (!state.info?.canInstall) { updates.install(); return; } // running from source: open the download
  set({ phase: "downloading", progress: 0, hidden: false, error: null });
  try {
    await updates.download();
    set({ phase: "ready", ready: state.info.version });
  } catch (e) {
    set({ phase: "error", error: String(e?.message || e) });
  }
}

async function install() {
  set({ phase: "installing" });
  try { await updates.install(); } catch (e) { set({ phase: "error", error: String(e?.message || e) }); }
}

function later() {
  try { localStorage.setItem(SKIP, state.info?.version || ""); } catch { /* ignore */ }
  set({ hidden: true });
}

function bindButtons(root) {
  root.querySelectorAll("[data-upd]").forEach((b) => {
    b.onclick = () => ({
      check: () => checkForUpdates(true), download, install, later, hide: () => set({ hidden: true }),
      notes: () => root.querySelector(".upd-notes")?.toggleAttribute("hidden"),
      page: () => updates.openPage(),
    })[b.dataset.upd]?.();
  });
}

const notesHtml = (info, hidden) => {
  const text = notesOf(info);
  return text ? `<pre class="upd-notes" ${hidden ? "hidden" : ""}>${esc(text)}</pre>`
    : `<p class="muted small upd-notes" ${hidden ? "hidden" : ""}>See what's new on the <button class="linkish" data-upd="page">release page</button>.</p>`;
};

/** The floating bar shown while there's something to say about an update. */
function renderBar(bar) {
  const s = state, v = esc(s.info?.version || "");
  const show = s.info && !s.hidden && ["available", "downloading", "ready", "installing", "error"].includes(s.phase);
  bar.hidden = !show;
  if (!show) return;
  bar.innerHTML = {
    available: `<span>⬇ <b>LinkCharts ${v}</b> is available (you have ${esc(s.info.current)}).</span>
      <button class="linkish" data-upd="notes">What's new</button><span class="spacer"></span>
      <button class="primary" data-upd="download">${s.info.canInstall ? "Update now" : "Download"}</button><button data-upd="later">Later</button>
      ${notesHtml(s.info, true)}`,
    downloading: `<span>Downloading LinkCharts ${v}… ${pct()}</span><span class="upd-progress"><i style="width:${pct()}"></i></span>`,
    ready: `<span>⬇ <b>LinkCharts ${v}</b> is ready. LinkCharts will close, update and open again.</span><span class="spacer"></span>
      <button class="primary" data-upd="install">Restart & update</button><button data-upd="hide">Later</button>`,
    installing: `<span>Installing LinkCharts ${v} — it will open again in a moment…</span>`,
    error: `<span class="down">Update failed: ${esc(s.error || "")}</span><span class="spacer"></span>
      <button data-upd="download">Try again</button><button data-upd="hide">✕</button>`,
  }[s.phase];
  bindButtons(bar);
}

/** Checks a few seconds after the app opens and every 6 hours (unless turned off in ⚙). */
export function startUpdates() {
  if (!updates) return;
  const bar = document.createElement("div");
  bar.className = "update-bar";
  bar.hidden = true;
  document.body.appendChild(bar);
  listeners.add(() => renderBar(bar));
  updates.onProgress((p) => set({ progress: p }));
  const auto = () => autoOn() && checkForUpdates(false);
  setTimeout(auto, 8000);
  setInterval(auto, 6 * 3600 * 1000);
}

/** "App updates" section for the ⚙ dialog (fills `el`; keeps itself up to date while open). */
export function mountUpdatesSection(el) {
  if (!updates) { el.remove(); return; }
  const render = () => {
    if (!el.isConnected) { listeners.delete(render); return; }
    const s = state, busy = ["checking", "downloading", "installing"].includes(s.phase);
    el.innerHTML = `<h4>App updates</h4>
      <div class="upd-row"><span>${s.info ? `You have LinkCharts ${esc(s.info.current)}.` : ""}</span>
        <button data-upd="check" ${busy ? "disabled" : ""}>${s.phase === "checking" ? "Checking…" : "Check for updates"}</button></div>
      ${s.phase === "latest" ? `<p class="up small">You have the newest version.</p>` : ""}
      ${s.phase === "error" ? `<p class="down small">${esc(s.error || "")}</p>` : ""}
      ${["available", "downloading", "ready", "installing"].includes(s.phase) ? `<div class="upd-box"><b>LinkCharts ${esc(s.info.version)}</b> is available.
        ${notesHtml(s.info, false)}
        ${s.phase === "available" ? `<button class="primary" data-upd="download">${s.info.canInstall ? "Update now" : "Download"}</button>` : ""}
        ${s.phase === "downloading" ? `<p>Downloading… ${pct()}</p>` : ""}
        ${s.phase === "ready" ? `<button class="primary" data-upd="install">Restart & update</button>` : ""}
        ${s.phase === "installing" ? `<p>Installing — LinkCharts will open again in a moment…</p>` : ""}</div>` : ""}
      <label class="check small"><input type="checkbox" id="upd-auto" ${autoOn() ? "checked" : ""} /> Check for updates automatically when LinkCharts opens</label>`;
    bindButtons(el);
    el.querySelector("#upd-auto").onchange = (e) => { try { localStorage.setItem(AUTO, e.target.checked ? "1" : "0"); } catch { /* ignore */ } };
  };
  listeners.add(render);
  render();
  if (!state.info) updates.check().then((info) => { if (!state.info) set({ info, phase: info.available ? "available" : "latest" }); }).catch(() => {});
}
