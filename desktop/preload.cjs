// Bridge between the LinkCharts page and the desktop app: in-app updates (see updater.cjs).
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("linkchartsDesktop", {
  updates: {
    check: () => ipcRenderer.invoke("updates:check"),
    download: () => ipcRenderer.invoke("updates:download"),
    install: () => ipcRenderer.invoke("updates:install"),
    openPage: () => ipcRenderer.invoke("updates:open-page"),
    onProgress: (cb) => ipcRenderer.on("updates:progress", (_e, p) => cb(p)),
  },
});
