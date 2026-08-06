import _eval from 'node-eval'
import { replaceSessionIpcListeners } from './ipcSessionHandlers.mjs'

let mainWindow
let proxy
let scriptingEnabled = false
let currentScript
let currentScriptModule
let disposeIpcListeners

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

function handleInjectPacket (event, arg) {
  if (!proxy) return
  const ipcMessage = JSON.parse(arg)
  if (ipcMessage.direction === 'clientbound') {
    proxy.writeToClient(ipcMessage.meta, ipcMessage.data, false)
  } else {
    proxy.writeToServer(ipcMessage.meta, ipcMessage.data, false)
  }
}

function handleScriptStateChange (event, arg) {
  if (!proxy || !mainWindow) return
  const ipcMessage = JSON.parse(arg)
  scriptingEnabled = ipcMessage.scriptingEnabled
  proxy.setScriptingEnabled(scriptingEnabled)
  currentScript = ipcMessage.script
  // Prevent the script from being executed when scripting is disabled.
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
}

export function init (window, passedIpcMain, passedProxy) {
  dispose()
  mainWindow = window
  proxy = passedProxy

  disposeIpcListeners = replaceSessionIpcListeners(disposeIpcListeners, passedIpcMain, {
    injectPacket: handleInjectPacket,
    scriptStateChange: handleScriptStateChange
  })
}

export function dispose () {
  disposeIpcListeners?.()

  mainWindow = undefined
  proxy = undefined
  scriptingEnabled = false
  currentScript = undefined
  currentScriptModule = undefined
  disposeIpcListeners = undefined
}

export function packetHandler (direction, meta, data, id, raw, canUseScripting, packetValid, sizeInfo, deserializationError) {
  if (!mainWindow || !proxy) return
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
  if (!mainWindow) return
  mainWindow.send('message', JSON.stringify({ header: header, info: info, fatal: fatal }))
}
