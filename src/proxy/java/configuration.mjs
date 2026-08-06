const proxiedStates = new Set(['configuration', 'play'])

export function shouldProxyState (state) {
  return proxiedStates.has(state)
}

// Both minecraft-protocol endpoints must still handle handshake, encryption,
// compression and the login acknowledgement themselves. During configuration,
// however, packets should come from the remote server and the real client.
// Block only the packets the library would otherwise synthesize automatically;
// writeRaw remains available for the packets forwarded by the bridge.
export function installGeneratedPacketBlocker (client, configurationState, packetNames) {
  const blockedPackets = new Set(packetNames)
  const write = client.write.bind(client)

  client.write = (name, params) => {
    if (client.state === configurationState && blockedPackets.has(name)) return
    return write(name, params)
  }
}

export function createStatePacketQueue (destination, states, forward, onOverflow, maxPending = 4096) {
  const pending = []

  function disposition (meta) {
    if (destination.state === meta.state) return 'forward'

    // minecraft-protocol changes its local state while handling the Finish
    // Configuration event, before the peer has received the forwarded reply.
    // writeRaw is state-independent, so this final configuration packet is
    // still safe (and required) after the local endpoint moved to PLAY.
    if (meta.state === states.CONFIGURATION &&
        meta.name === 'finish_configuration' &&
        destination.state === states.PLAY) {
      return 'forward'
    }

    // The client writes this acknowledgement with the PLAY codec and then
    // immediately switches its local endpoint to CONFIGURATION. The remote
    // server is still in PLAY until it receives the forwarded raw packet.
    if (meta.state === states.PLAY &&
        meta.name === 'configuration_acknowledged' &&
        destination.state === states.CONFIGURATION) {
      return 'forward'
    }

    if (meta.state === states.PLAY && destination.state !== states.PLAY) return 'queue'
    if (meta.state === states.CONFIGURATION &&
        destination.state !== states.CONFIGURATION &&
        destination.state !== states.PLAY) {
      return 'queue'
    }

    return 'discard'
  }

  function flush () {
    for (let index = 0; index < pending.length;) {
      const action = disposition(pending[index].meta)
      if (action === 'queue') {
        index++
      } else {
        const [packet] = pending.splice(index, 1)
        if (action === 'forward') forward(packet)
      }
    }
  }

  destination.on('state', flush)

  return packet => {
    const action = disposition(packet.meta)
    if (action === 'forward') {
      forward(packet)
    } else if (action === 'queue') {
      if (pending.length >= maxPending) {
        onOverflow?.()
        return
      }
      pending.push(packet)
    }
  }
}
