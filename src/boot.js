// Startup: load saved data from this PC (market-app/data/userdata.json) into the browser before the
// app reads it, so everything comes back even if the browser's storage was cleared.
import { SAVED_AT, snapshot, saveToDisk } from "./util.js";

try {
  const disk = await (await fetch("/api/userdata")).json();
  const local = snapshot();
  const localTime = +(localStorage.getItem(SAVED_AT) || 0);
  if (disk.savedAt > localTime && Object.keys(disk.items || {}).length) {
    // The file is newer (e.g. browser data was cleared, or another browser saved since): use it.
    for (const k of Object.keys(local.items)) localStorage.removeItem(k);
    for (const [k, v] of Object.entries(disk.items)) localStorage.setItem(k, v);
    localStorage.setItem(SAVED_AT, String(disk.savedAt));
  } else if (Object.keys(local.items).length && localTime >= disk.savedAt) {
    // The browser has data the file doesn't yet (first run after this update): write it to disk now.
    if (!localTime) localStorage.setItem(SAVED_AT, String(Date.now()));
    await saveToDisk();
  }
} catch { /* server unreachable: start from whatever the browser has */ }

await import("./app.js");
