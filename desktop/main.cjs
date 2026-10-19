// LinkCharts desktop app: runs the local server (server.mjs) inside the app and shows it in a window.
// No Node.js install or browser needed. Data (API keys, watchlists, drawings…) lives in the user's
// app-data folder, so it survives updates and reinstalls.
const { app, BrowserWindow, Menu, shell } = require("electron");
const path = require("path");
const net = require("net");
const { pathToFileURL } = require("url");

const root = path.join(__dirname, "..");
let win = null;
let url = null;

/** A free local port, preferring 5174 (the port the browser version uses). */
function freePort(start = 5174) {
  return new Promise((resolve) => {
    const tryPort = (p) => {
      const s = net.createServer();
      s.once("error", () => tryPort(p + 1));
      s.once("listening", () => s.close(() => resolve(p)));
      s.listen(p, "127.0.0.1");
    };
    tryPort(start);
  });
}

async function startServer() {
  const port = await freePort();
  process.env.LINKCHARTS_PORT = String(port);
  process.env.LINKCHARTS_DATA = path.join(app.getPath("userData"), "data");
  await import(pathToFileURL(path.join(root, "server.mjs")).href);
  url = `http://127.0.0.1:${port}/`;
  // Wait until it answers.
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(url)).ok) return; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 900, minHeight: 560,
    title: "LinkCharts", backgroundColor: "#131722", autoHideMenuBar: true, show: false,
    icon: path.join(root, "build", "icon.png"),
    webPreferences: { contextIsolation: true, sandbox: true },
  });
  win.once("ready-to-show", () => win.show());
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type !== "keyDown") return;
    if (input.key === "F12" || (input.control && input.shift && input.key.toLowerCase() === "i")) win.webContents.toggleDevTools();
    if (input.key === "F5" || (input.control && input.key.toLowerCase() === "r")) win.webContents.reload();
  });
  // Links to other sites open in the normal browser.
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    if (/^https?:/.test(u) && !u.startsWith(url)) shell.openExternal(u);
    return { action: "deny" };
  });
  win.webContents.on("will-navigate", (e, u) => {
    if (!u.startsWith(url)) { e.preventDefault(); if (/^https?:/.test(u)) shell.openExternal(u); }
  });
  win.loadURL(url);
  win.on("closed", () => (win = null));
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(async () => {
    Menu.setApplicationMenu(process.platform === "darwin"
      ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }])
      : null);
    await startServer();
    createWindow();
    app.on("activate", () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
  });
  app.on("window-all-closed", () => app.quit());
}
