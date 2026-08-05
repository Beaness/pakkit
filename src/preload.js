import { ipcRenderer } from 'electron'

// The renderer runs as Chromium ESM (no access to `electron` or `node_modules`
// at runtime), so the preload bridges the few Electron APIs the UI needs.
// electron-store stays in the main process; the renderer reads/writes settings
// through this synchronous IPC proxy.
window.ipcRenderer = ipcRenderer

window.store = {
  get: (key) => ipcRenderer.sendSync('store-get', key),
  set: (key, value) => ipcRenderer.sendSync('store-set', JSON.stringify({ key, value })),
  has: (key) => ipcRenderer.sendSync('store-has', key)
}
