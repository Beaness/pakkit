// Modified from https://github.com/PrismarineJS/node-minecraft-protocol/blob/master/examples/proxy/proxy.js

import net from 'node:net'
import minecraftFolder from 'minecraft-folder-path'
import bufferEqual from 'buffer-equal'
import {
  createStatePacketQueue,
  installGeneratedPacketBlocker,
  shouldProxyState
} from './configuration.mjs'
import { isPacketParseError, observeRawPackets } from './rawPacketCapture.mjs'

let mc
let minecraftData
let states

let realClient
let realServer
let toClientMappings
let toServerMappings
let statePacketMappings
let storedCallback

let scriptingEnabled = false

// https://gist.github.com/timoxley/1689041
function isPortTaken (port, fn) {
  const tester = net.createServer()
    .once('error', function (err) {
      if (err.code !== 'EADDRINUSE') return fn(err)
      fn(null, true)
    })
    .once('listening', function () {
      tester.once('close', function () { fn(null, false) })
        .close()
    })
    .listen(port)
}

export const capabilities = {
  modifyPackets: true,
  jsonData: true,
  rawData: true,
  scriptingSupport: true,
  clientboundPackets: [],
  serverboundPackets: [],
  versionId: undefined
}

let authWindowOpen = false

export function initializeDependencies (dependencies) {
  mc = dependencies.minecraftProtocol
  minecraftData = dependencies.minecraftData
  states = mc.states
}

function configureVersion (version) {
  const mcdata = minecraftData(version)
  if (!mcdata) {
    throw new Error('Unsupported Minecraft protocol version: ' + version)
  }

  const resolvedVersion = mcdata.version.minecraftVersion

  // . cannot be in a JSON property name with electron-store
  capabilities.versionId = 'java-node-minecraft-protocol-' + resolvedVersion.split('.').join('-')
  toClientMappings = mcdata.protocol.play.toClient.types.packet[1][0].type[1].mappings
  toServerMappings = mcdata.protocol.play.toServer.types.packet[1][0].type[1].mappings
  statePacketMappings = {
    [states.PLAY]: {
      toClient: toClientMappings,
      toServer: toServerMappings
    }
  }

  if (mcdata.protocol.configuration) {
    statePacketMappings[states.CONFIGURATION] = {
      toClient: mcdata.protocol.configuration.toClient.types.packet[1][0].type[1].mappings,
      toServer: mcdata.protocol.configuration.toServer.types.packet[1][0].type[1].mappings
    }
  }

  capabilities.clientboundPackets = toClientMappings
  capabilities.serverboundPackets = toServerMappings

  return resolvedVersion
}

function getPacketMappings (state, direction) {
  return statePacketMappings?.[state]?.[direction] || {}
}

export function startProxy (host, port, listenPort, version, onlineMode, authConsent, callback, messageCallback, dataFolder,
  updateFilteringCallback, authCodeCallback) {
  if (!mc || !minecraftData) throw new Error('Java proxy dependencies have not been initialized')
  storedCallback = callback
  authConsent = false
  const useClientVersion = version.toLowerCase() === 'auto'

  if (useClientVersion) {
    capabilities.versionId = 'java-node-minecraft-protocol-auto'
    capabilities.clientboundPackets = []
    capabilities.serverboundPackets = []
  } else {
    configureVersion(version)
  }

  isPortTaken(listenPort, (err, taken) => {
    // TODO: Handle errors
    console.log(err, taken)
    if (taken) {
      console.log('call')
      // Wait for the renderer to be ready
      setTimeout(() => {
        messageCallback('Unable to start pakkit', 'The port ' + listenPort + ' is in use. ' +
          'Make sure to close any other instances of pakkit running on the same port or try a different port.', true)
      }, 1000)
    } else {
      let srv
      try {
        const serverOptions = {
          'online-mode': onlineMode,
          port: listenPort,
          keepAlive: false,
          // minecraft-protocol reads the protocol version from each incoming
          // handshake when the server version is false.
          version: useClientVersion ? false : version
        }
        if (useClientVersion) {
          serverOptions.beforeLogin = function (client) {
            const mcdata = minecraftData(client.protocolVersion)
            const resolvedVersion = configureVersion(client.protocolVersion)

            // createServer initially uses its default version for this data;
            // replace it before configuration starts with the detected
            // client's version-specific codec.
            serverOptions.registryCodec = mcdata.registryCodec || mcdata.loginPacket?.dimensionCodec

            console.log('Detected client version', resolvedVersion, '(protocol ' + client.protocolVersion + ')')
            updateFilteringCallback()
          }
        }
        srv = mc.createServer(serverOptions)
        console.log('Proxy started (Java)!')
      } catch (err) {
        const header = 'Unable to start pakkit'
        let message = err.message
        if (err.message.includes('EADDRINUSE')) {
          message = 'The port ' + listenPort + ' is in use. ' +
            'Make sure to close any other instances of pakkit running on the same port or try a different port.'
        }
        messageCallback(header, message)
        return
      }
      srv.on('login', function (client) {
        realClient = client
        const connectionVersion = useClientVersion ? client.protocolVersion : version
        const addr = client.socket.remoteAddress
        console.log('Incoming connection', '(' + addr + ')')
        let endedClient = false
        let endedTargetClient = false
        client.on('end', function () {
          endedClient = true
          console.log('Connection closed by client', '(' + addr + ')')
          if (!endedTargetClient) { targetClient.end('End') }
        })
        client.on('error', function (err) {
          if (isPacketParseError(err)) {
            console.warn('Client packet could not be deserialized; forwarded the raw packet instead')
            return
          }
          endedClient = true
          console.log('Connection error by client', '(' + addr + ')')
          console.log(err.stack)
          if (!endedTargetClient) { targetClient.end('Error') }
        })
        // if (authConsent) {
        //   console.log('Will attempt to use launcher_profiles.json for online mode login data')
        // } else {
        //   console.warn('Consent not given to use launcher_profiles.json - automatic online mode will not work')
        // }
        const clientOptions = {
          host,
          port,
          username: client.username,
          keepAlive: false,
          version: connectionVersion,
          profilesFolder: authConsent ? minecraftFolder : dataFolder,
          auth: onlineMode ? 'microsoft' : 'offline',
          onMsaCode: function (data) {
            console.log('MSA code:', data.user_code)
            authWindowOpen = true
            authCodeCallback(data)
          }
        }

        // The local server and upstream client still own LOGIN. From
        // CONFIGURATION onward, prevent their built-in plugins from producing
        // substitute packets so the real packets can pass through unchanged.
        installGeneratedPacketBlocker(client, states.CONFIGURATION, [
          'registry_data',
          'finish_configuration'
        ])

        const targetClient = mc.createClient(clientOptions)
        installGeneratedPacketBlocker(targetClient, states.CONFIGURATION, [
          'settings',
          'select_known_packs',
          'accept_code_of_conduct',
          'finish_configuration'
        ])
        installGeneratedPacketBlocker(targetClient, states.PLAY, [
          'configuration_acknowledged'
        ])
        targetClient.on('session', function (session) {
          // Login complete - the dialog can be closed
          console.log('Login done')
          authWindowOpen = false
          authCodeCallback('close')
        })

        realServer = targetClient

        function getId (meta, mappings) {
          let id
          if (typeof meta.name === 'number') {
            // Unknown packet ID
            id = '0x' + meta.name.toString(16).padStart(2, '0')
            meta.name = 'unknown'
          } else {
            id = Object.keys(mappings).find(key => mappings[key] === meta.name)
          }
          return id
        }

        const validationSerializers = new Map()

        function validatePacket (direction, data, meta, raw) {
          if (typeof meta.name === 'number') return false

          try {
            const key = direction + ':' + meta.state
            let serializer = validationSerializers.get(key)
            if (!serializer) {
              serializer = mc.createSerializer({
                state: meta.state,
                isServer: direction === 'clientbound',
                version: connectionVersion
              })
              serializer.on('error', () => {})
              validationSerializers.set(key, serializer)
            }

            const packetBuff = serializer.createPacketBuffer({ name: meta.name, params: data })
            if (bufferEqual(raw, packetBuff)) return true

            console.log(direction + ': Error in packet ' + meta.state + '.' + meta.name)
            console.log('received buffer', raw.toString('hex'))
            const producedHex = packetBuff.toString('hex')
            console.log(
              producedHex.length > 1000 ? 'produced buffer (cut off to 1000 chars)' : 'produced buffer',
              producedHex.slice(0, 1000)
            )
            console.log('received length', raw.length)
            console.log('produced length', packetBuff.length)
          } catch (e) {
            // Unknown or deliberately malformed packets are still forwarded raw.
          }

          return false
        }

        function writeCapturedRaw (destination, packet) {
          if (packet.rawEncoding === 'compressed' && destination.compressor !== null) {
            // Decompression itself failed. Preserve the original compressed
            // payload instead of trying to compress it a second time.
            destination.framer.write(packet.raw)
          } else {
            destination.writeRaw(packet.raw)
          }
        }

        function handleServerboundPacket (data, meta, raw, packetValid, sizeInfo, deserializationError, rawEncoding) {
          const id = getId(meta, getPacketMappings(meta.state, 'toServer'))

          // Configuration traffic must remain transparent. PLAY packets keep
          // the existing scripting behavior, except state transition packets.
          const direction = 'serverbound'
          const canUseScripting = meta.state === states.PLAY && meta.name !== 'configuration_acknowledged'

          if (!endedTargetClient) {
            if (deserializationError || !scriptingEnabled || !canUseScripting) {
              writeCapturedRaw(targetClient, { raw, rawEncoding })
            }
            callback(direction, meta, data, id, [...raw], canUseScripting, packetValid, sizeInfo, deserializationError)
          }
        }

        function handleClientboundPacket (data, meta, raw, packetValid, sizeInfo, deserializationError, rawEncoding) {
          const id = getId(meta, getPacketMappings(meta.state, 'toClient'))

          const direction = 'clientbound'
          const canUseScripting = meta.state === states.PLAY && meta.name !== 'start_configuration'

          if (!endedClient) {
            if (meta.state === states.PLAY && meta.name === 'start_configuration') {
              // The server-side Client has no built-in handler for a remote
              // reconfiguration request because it did not originate that
              // request itself. Follow the real client's acknowledgements so
              // its deserializer changes states at the same packet boundaries.
              client.once('configuration_acknowledged', () => {
                if (client.state !== states.PLAY) return
                client.state = states.CONFIGURATION
                client.once('finish_configuration', () => {
                  if (client.state === states.CONFIGURATION) client.state = states.PLAY
                })
              })
            }
            if (deserializationError || !scriptingEnabled || !canUseScripting) {
              writeCapturedRaw(client, { raw, rawEncoding })
            }
            callback(direction, meta, data, id, [...raw], canUseScripting, packetValid, sizeInfo, deserializationError)
          }
        }

        function handleQueueOverflow () {
          const message = 'Too many packets were queued while the client and server were changing protocol states.'
          messageCallback('Unable to bridge Minecraft protocol states', message)
          if (!endedClient) client.end(message)
          if (!endedTargetClient) targetClient.end(message)
        }

        const routeToServer = createStatePacketQueue(
          targetClient,
          states,
          packet => handleServerboundPacket(
            packet.data,
            packet.meta,
            packet.raw,
            packet.packetValid,
            packet.sizeInfo,
            packet.deserializationError,
            packet.rawEncoding
          ),
          handleQueueOverflow
        )
        const routeToClient = createStatePacketQueue(
          client,
          states,
          packet => handleClientboundPacket(
            packet.data,
            packet.meta,
            packet.raw,
            packet.packetValid,
            packet.sizeInfo,
            packet.deserializationError,
            packet.rawEncoding
          ),
          handleQueueOverflow
        )

        // Capture before deserialization so even malformed packets are routed.
        // Successful packets are also handled here to keep forwarding ordered.
        observeRawPackets(targetClient, state => getPacketMappings(state, 'toClient'), packet => {
          if (!shouldProxyState(packet.meta.state)) return
          if (!packet.deserializationError) {
            packet.packetValid = validatePacket('clientbound', packet.data, packet.meta, packet.raw)
          }
          routeToClient(packet)
        })

        observeRawPackets(client, state => getPacketMappings(state, 'toServer'), packet => {
          if (!shouldProxyState(packet.meta.state)) return
          if (!packet.deserializationError) {
            packet.packetValid = validatePacket('serverbound', packet.data, packet.meta, packet.raw)
          }
          routeToServer(packet)
        })
        targetClient.on('end', function () {
          endedTargetClient = true
          console.log('Connection closed by server', '(' + host + ':' + port + ')')
          if (!endedClient) { client.end('Connection closed by server ' + '(' + host + ':' + port + ')') }
        })
        targetClient.on('error', function (err) {
          if (isPacketParseError(err)) {
            console.warn('Server packet could not be deserialized; forwarded the raw packet instead')
            return
          }
          endedTargetClient = true
          console.log('Connection error by server', '(' + host + ':' + port + ') ', err)
          console.log(err.stack)
          if (authWindowOpen) return
          const header = 'Unable to connect to server'
          let message = err.message
          if (err.message.includes('ECONNREFUSED')) {
            message = 'Unable to connect to the Java server at ' +
              host + ':' + port +
              '. Make sure the server is online.'
          }
          messageCallback(header, message)
          if (!endedClient) { client.end('pakkit - ' + header + '\n' + message) }
        })
      })
    }
  })
}

export function end () {}

export function writeToClient (meta, data, noCallback) {
  if (typeof meta === 'string') {
    meta = { name: meta }
  }
  realClient.write(meta.name, data)
  const mappings = getPacketMappings(realClient.state, 'toClient')
  const id = Object.keys(mappings).find(key => mappings[key] === meta.name)
  if (!noCallback) {
    storedCallback('clientbound', meta, data, id) // TODO: indicator for injected packets
  }
}

export function writeToServer (meta, data, noCallback) {
  if (typeof meta === 'string') {
    meta = { name: meta }
  }
  realServer.write(meta.name, data)
  const mappings = getPacketMappings(realServer.state, 'toServer')
  const id = Object.keys(mappings).find(key => mappings[key] === meta.name)
  if (!noCallback) {
    storedCallback('serverbound', meta, data, id)
  }
}

export function setScriptingEnabled (isEnabled) {
  scriptingEnabled = isEnabled
}
