export function replaceSessionIpcListeners (previousDispose, ipcMain, handlers) {
  previousDispose?.()

  ipcMain.on('injectPacket', handlers.injectPacket)
  ipcMain.on('scriptStateChange', handlers.scriptStateChange)

  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    ipcMain.removeListener('injectPacket', handlers.injectPacket)
    ipcMain.removeListener('scriptStateChange', handlers.scriptStateChange)
  }
}
