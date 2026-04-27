// Bridges the setup page <-> main process. Exposed as window.api.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  saveServer: (url) => ipcRenderer.invoke("config:save", url),
  loadConfig: () => ipcRenderer.invoke("config:load"),
  onCurrentConfig: (cb) => ipcRenderer.on("config:current", (_e, url) => cb(url)),
});
