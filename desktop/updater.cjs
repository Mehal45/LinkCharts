// In-app updates from the app's GitHub Releases (the same file is in Cutline and LinkCharts).
// The page asks "is there a newer version?"; on Windows the new installer is then downloaded in the
// background and run silently once the app has closed, and the new version opens by itself. A Mac app that
// isn't signed by Apple can't replace itself, so there the new download just opens in the browser.
const { app, ipcMain, shell, net } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

/** True when version a ("1.23.0") is newer than b. */
function newer(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0), pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

/**
 * repo: "Owner/Name" on GitHub. assets: { win32: /Setup-.*\.exe$/, darwin: /\.dmg$/ } — which release file
 * is this computer's installer.
 */
function setupUpdates({ repo, assets }) {
  let latest = null; // { version, notes, page, asset: { name, url, size } | null }
  let file = null; // the downloaded installer
  let downloading = null;

  async function check() {
    const r = await net.fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": `${app.getName()}/${app.getVersion()}` },
    });
    if (!r.ok) throw new Error(r.status === 403 ? "GitHub is busy right now — try again in a few minutes." : `GitHub answered ${r.status}.`);
    const rel = await r.json();
    const a = (rel.assets || []).find((x) => assets[process.platform]?.test(x.name));
    latest = {
      version: String(rel.tag_name || "").replace(/^v/i, ""),
      notes: rel.body || "",
      page: rel.html_url,
      asset: a ? { name: a.name, url: a.browser_download_url, size: a.size } : null,
    };
    return {
      current: app.getVersion(),
      version: latest.version,
      notes: latest.notes,
      page: latest.page,
      available: newer(latest.version, app.getVersion()),
      // Running from source (npm start) there's no installed app to replace.
      canInstall: process.platform === "win32" && !!latest.asset && app.isPackaged,
    };
  }

  async function download(sender) {
    if (!latest?.asset) await check();
    const a = latest.asset;
    if (!a) throw new Error("This release has no installer for this computer.");
    const dest = path.join(os.tmpdir(), `${app.getName()} update`, a.name);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest) && fs.statSync(dest).size === a.size) return (file = dest); // downloaded before
    const r = await net.fetch(a.url);
    if (!r.ok || !r.body) throw new Error(`The download failed (${r.status}).`);
    const part = dest + ".part";
    const out = fs.createWriteStream(part);
    let got = 0, told = 0;
    try {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        got += value.length;
        if (!out.write(value)) await new Promise((res) => out.once("drain", res));
        if (Date.now() - told > 150) { told = Date.now(); if (!sender.isDestroyed()) sender.send("updates:progress", a.size ? got / a.size : 0); }
      }
    } finally {
      await new Promise((res) => out.end(res));
    }
    if (a.size && got !== a.size) throw new Error("The download was interrupted — try again.");
    fs.renameSync(part, dest);
    return (file = dest);
  }

  ipcMain.handle("updates:check", () => check());
  ipcMain.handle("updates:download", (e) => (downloading ||= download(e.sender).finally(() => { downloading = null; })).then(() => true));
  ipcMain.handle("updates:install", () => {
    if (process.platform !== "win32" || !app.isPackaged) {
      shell.openExternal(latest?.asset?.url || latest?.page || `https://github.com/${repo}/releases/latest`);
      return false;
    }
    if (!file) throw new Error("Download the update first.");
    // Close normally (the app saves your work on the way out); once it has quit, the installer runs
    // silently into the same folder (--updated keeps shortcuts and settings) and opens the new version
    // (--force-run) — the way electron-updater does it.
    const installer = file;
    app.once("quit", () => {
      spawn(installer, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore" }).unref();
    });
    setTimeout(() => app.quit(), 100);
    return true;
  });
  ipcMain.handle("updates:open-page", () => shell.openExternal(latest?.page || `https://github.com/${repo}/releases/latest`));
}

module.exports = { setupUpdates, newer };
