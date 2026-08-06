import _eval from 'node-eval'

let mainWindow
let ipcMain
let proxy
let scriptingEnabled = false
let currentScript
let currentScriptModule

const server = {
  sendPacket: function (meta, data) {
    proxy.writeToServer(meta, data, true)
  }
}

const client = {
  sendPacket: function (meta, data) {
    proxy.writeToClient(meta, data, true)
  }
}

function reportScriptError (err) {
  const message = err && err.message ? err.message : String(err)
  mainWindow.send('scriptStatus', JSON.stringify({
    status: 'error',
    message: message,
    stack: err && err.stack ? err.stack : message
  }))
  console.error(err)
}

export function init (window, passedIpcMain, passedProxy) {
  mainWindow = window
  ipcMain = passedIpcMain
  proxy = passedProxy

  ipcMain.on('injectPacket', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    if (ipcMessage.direction === 'clientbound') {
      passedProxy.writeToClient(ipcMessage.meta, ipcMessage.data, false)
    } else {
      passedProxy.writeToServer(ipcMessage.meta, ipcMessage.data, false)
    }
  })

  ipcMain.on('scriptStateChange', (event, arg) => {
    const ipcMessage = JSON.parse(arg)
    scriptingEnabled = ipcMessage.scriptingEnabled
    proxy.setScriptingEnabled(scriptingEnabled)
    currentScript = ipcMessage.script
    // prevent that the script gets executed when scripting is disabled
    if (scriptingEnabled) {
      try {
        const evaluatedScriptModule = _eval(currentScript, '/script.js')
        currentScriptModule = evaluatedScriptModule
        mainWindow.send('scriptStatus', JSON.stringify({ status: 'success' }))
      } catch (err) {
        reportScriptError(err)
      }
    } else {
      currentScriptModule = _eval('', '/script.js')
      mainWindow.send('scriptStatus', JSON.stringify({ status: 'idle' }))
    }
  })
}

export function packetHandler (direction, meta, data, id, raw, canUseScripting, packetValid, sizeInfo, deserializationError) {
  try {
    const byteSize = raw?.length ?? 0
    const compressedByteSize = sizeInfo?.compressedByteSize ?? byteSize
    const wasCompressed = sizeInfo?.wasCompressed ?? false
    mainWindow.send('packet', JSON.stringify({ meta: meta, data: data, direction: direction, hexIdString: id, raw: raw, byteSize: byteSize, compressedByteSize: compressedByteSize, wasCompressed: wasCompressed, time: Date.now(), packetValid: packetValid, deserializationError: deserializationError }))
    // TODO: Maybe write raw data?
    if (proxy.capabilities.scriptingSupport && canUseScripting && scriptingEnabled) {
      try {
        if (direction === 'clientbound') {
          currentScriptModule.downstreamHandler(meta, data, server, client)
        } else {
          currentScriptModule.upstreamHandler(meta, data, server, client)
        }
      } catch (err) {
        reportScriptError(err)
      }
    }
  } catch (err) {
    console.error(err)
  }
}

export function messageHandler (header, info, fatal) {
  mainWindow.send('message', JSON.stringify({ header: header, info: info, fatal: fatal }))
}
