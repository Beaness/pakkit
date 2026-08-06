import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'

let child
let ws
let wsPort
let wsToken
let restartTimer
let websocketRetryTimer
let stdoutBuffer = ''
let recentErrorOutput = ''
let stopped = false
let restartRequested = false
let failureReported = false

export const capabilities = {
  modifyPackets: true,
  jsonData: true,
  rawData: true,
  scriptingSupport: false,
  clientboundPackets: {},
  serverboundPackets: {},
  minecraftVersion: undefined,
  protocolVersion: undefined,
  versionId: 'bedrock-proxypass-json'
}

let host
let port
let listenPort
let packetCallback
let messageCallback
let dataFolder
let updateFilteringCallback

function freePort () {
  return new Promise((resolve, reject) => {
    const server = net.createServer(socket => socket.end())
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port
      server.close(error => error ? reject(error) : resolve(port))
    })
  })
}

function reportFailure (header, info) {
  if (failureReported || stopped) return
  failureReported = true
  messageCallback(header, info, true)
}

async function launch () {
  if (stopped) return

  wsPort = Number(await freePort())
  wsToken = randomBytes(24).toString('hex')
  stdoutBuffer = ''
  recentErrorOutput = ''
  restartRequested = false
  failureReported = false

  const jarPath = path.join(dataFolder, 'proxypass', 'proxypass-pakkit.jar')
  const args = [
    '-jar', jarPath, '--start-from-args', '0.0.0.0', listenPort.toString(), host, port.toString(),
    '1', 'true', 'true', 'pakkit', 'pakkitProxyPoweredByProxyPass', 'true', wsPort.toString(), wsToken
  ]

  child = spawn('java', args, {
    cwd: path.dirname(jarPath),
    windowsHide: true
  })

  child.stdout.on('data', handleOutput)
  child.stderr.on('data', handleError)
  child.once('error', error => {
    const missingJava = error.code === 'ENOENT'
    reportFailure(
      missingJava ? 'Java 17 or newer is required' : 'Unable to start ProxyPass',
      missingJava
        ? 'Install a Java 17+ runtime and make sure the java command is available on PATH.'
        : error.message
    )
  })
  child.once('close', (code, signal) => {
    child = undefined
    closeWebsocket()
    if (stopped) return

    if (restartRequested) {
      restartTimer = setTimeout(() => {
        launch().catch(error => reportFailure('Unable to restart ProxyPass', error.message))
      }, 100)
      return
    }

    const javaVersionError = recentErrorOutput.includes('UnsupportedClassVersionError')
    reportFailure(
      javaVersionError ? 'Java 17 or newer is required' : 'ProxyPass stopped unexpectedly',
      javaVersionError
        ? 'The upgraded Bedrock proxy requires Java 17 or newer. Update Java and restart pakkit.'
        : `ProxyPass exited with ${signal ? `signal ${signal}` : `code ${code}`}.${recentErrorOutput ? `\n\n${recentErrorOutput}` : ''}`
    )
  })
}

function scheduleWebsocketRetry () {
  if (stopped || !child || websocketRetryTimer) return
  websocketRetryTimer = setTimeout(() => {
    websocketRetryTimer = undefined
    startWebsocket()
  }, 150)
}

function startWebsocket () {
  if (stopped || !child) return
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return

  const candidate = new WebSocket(`ws://127.0.0.1:${wsPort}/${wsToken}`)
  ws = candidate

  candidate.on('open', () => {
    console.log('Proxy started (Bedrock)!')
  })
  candidate.on('message', incoming)
  candidate.on('error', error => {
    if (ws === candidate) ws = undefined
    if (!stopped && child) {
      console.debug('ProxyPass WebSocket is not ready yet:', error.message)
      scheduleWebsocketRetry()
    }
  })
  candidate.on('close', () => {
    if (ws === candidate) ws = undefined
  })
}

function incoming (message) {
  let parsed
  try {
    parsed = JSON.parse(message.toString())
  } catch (error) {
    console.error('Invalid ProxyPass bridge message:', error)
    return
  }

  switch (parsed.type) {
    case 'packet':
      handlePacket(parsed.data)
      break
    case 'event':
      handleEvent(parsed)
      break
    default:
      console.log('Unknown ProxyPass message type', parsed.type)
  }
}

function normaliseRawBytes (packet) {
  let raw
  if (Array.isArray(packet.bytes)) {
    raw = packet.bytes.slice()
  } else if (typeof packet.bytes === 'string') {
    raw = Array.from(Buffer.from(packet.bytes, 'base64'))
  } else {
    raw = Object.values(packet.bytes ?? {})
  }

  // Bridge v1 sent only the payload, with the packet ID separately. Bridge v2
  // sends the complete variable-length Bedrock packet header and payload.
  if (!packet.includesHeader) raw.unshift(packet.packetId)
  return raw
}

function handlePacket (packet) {
  const name = packet.packetType.toLowerCase()
  let data
  try {
    data = JSON.parse(packet.jsonData)
  } catch (error) {
    data = { serializationError: error.message, packet: packet.jsonData }
  }

  const hexIdString = '0x' + packet.packetId.toString(16).padStart(2, '0')

  // These values are unneeded or are exposed elsewhere in the GUI.
  delete data.packetId
  delete data.packetType
  delete data.clientId
  delete data.senderId

  packetCallback(
    packet.direction,
    { name, className: packet.className },
    data,
    hexIdString,
    normaliseRawBytes(packet),
    !packet.isHandled,
    true
  )
}

function handleEvent (event) {
  switch (event.eventType) {
    case 'unableToConnect':
      messageCallback(
        'Unable to connect to server',
        `Unable to connect to the Bedrock server at ${event.eventData.replace(/^\//, '')}. Make sure the server is online.`
      )
      relaunch()
      break
    case 'disconnect':
      console.log('Bedrock connection closed - relaunching ProxyPass')
      relaunch()
      break
    case 'filteringPackets': {
      const packetTypes = JSON.parse(event.eventData)
      capabilities.clientboundPackets = {}
      capabilities.serverboundPackets = {}
      for (const [id, packetType] of Object.entries(packetTypes)) {
        const idString = '0x' + Number(id).toString(16).padStart(2, '0')
        const name = packetType.toLowerCase()
        capabilities.clientboundPackets[idString] = name
        capabilities.serverboundPackets[idString] = name
      }
      updateFilteringCallback()
      break
    }
    case 'proxyInfo': {
      const info = JSON.parse(event.eventData)
      capabilities.minecraftVersion = info.minecraftVersion
      capabilities.protocolVersion = info.protocolVersion
      capabilities.versionId = `bedrock-proxypass-json-${info.minecraftVersion.replaceAll('.', '-')}`
      console.log(`ProxyPass supports Bedrock ${info.minecraftVersion} (protocol ${info.protocolVersion})`)
      break
    }
    case 'injectionError':
      messageCallback('Unable to inject Bedrock packet', event.eventData)
      break
    default:
      console.log('Unknown ProxyPass event', event.eventType)
  }
}

function handleOutput (chunk) {
  stdoutBuffer += chunk.toString('utf8')
  const lines = stdoutBuffer.split(/\r?\n/)
  stdoutBuffer = lines.pop()
  for (const line of lines) {
    const text = line.trim()
    if (!text) continue
    console.log('ProxyPass output:', text)
    if (text.startsWith('ProxyPass - Websocket started on port: ')) {
      startWebsocket()
    }
  }
}

function handleError (chunk) {
  const text = chunk.toString('utf8').trim()
  if (!text) return
  recentErrorOutput = (recentErrorOutput + '\n' + text).trim().slice(-4000)
  console.log('ProxyPass error:', text)
}

export function startProxy (passedHost, passedPort, passedListenPort, version, onlineMode, authConsent, passedPacketCallback,
  passedMessageCallback, passedDataFolder, passedUpdateFilteringCallback, authCodeCallback) {
  host = passedHost
  port = passedPort
  listenPort = passedListenPort
  packetCallback = passedPacketCallback
  messageCallback = passedMessageCallback
  dataFolder = passedDataFolder
  updateFilteringCallback = passedUpdateFilteringCallback
  stopped = false

  launch().catch(error => reportFailure('Unable to start ProxyPass', error.message))
}

function closeWebsocket () {
  if (websocketRetryTimer) clearTimeout(websocketRetryTimer)
  websocketRetryTimer = undefined
  if (ws) {
    ws.removeAllListeners()
    ws.close()
    ws = undefined
  }
}

export function end () {
  stopped = true
  restartRequested = false
  if (restartTimer) clearTimeout(restartTimer)
  restartTimer = undefined
  closeWebsocket()
  if (child && !child.killed) child.kill()
  child = undefined
}

function relaunch () {
  if (stopped || restartRequested) return
  restartRequested = true
  closeWebsocket()
  if (child && !child.killed) {
    child.kill()
  } else {
    restartTimer = setTimeout(() => {
      launch().catch(error => reportFailure('Unable to restart ProxyPass', error.message))
    }, 100)
  }
}

function sendInjection (className, direction, data) {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    messageCallback('Unable to inject Bedrock packet', 'ProxyPass is not connected to pakkit.')
    return
  }
  ws.send(JSON.stringify({ type: 'inject', className, direction, data }))
}

export function writeToClient (meta, data) {
  sendInjection(meta.className, 'client', data)
}

export function writeToServer (meta, data) {
  sendInjection(meta.className, 'server', data)
}

export function setScriptingEnabled () {
  // ProxyPass packet scripting remains disabled; edit-and-resend uses injection.
}
