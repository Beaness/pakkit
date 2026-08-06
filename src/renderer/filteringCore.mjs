export function createPacketSearchText (packet) {
  let data
  try {
    data = JSON.stringify(packet.data)
  } catch {
    // Captured packets should already be serializable, but a bad packet must
    // not be able to stop indexing every packet that follows it.
    data = ''
  }

  return `${packet.hexIdString} ${packet.name} ${data}`
}

export function createFilter (query, inverseFiltering, regexFilter, hiddenPackets) {
  let regex
  if (regexFilter) {
    try {
      regex = new RegExp(query)
    } catch {
      // Keep the previous UI behaviour for an incomplete/invalid expression.
      regex = new RegExp('')
    }
  }

  return {
    query,
    inverseFiltering,
    regex,
    hiddenPackets: {
      serverbound: new Set(hiddenPackets.serverbound),
      clientbound: new Set(hiddenPackets.clientbound)
    }
  }
}

export function packetIsVisible (packet, filter) {
  if (filter.hiddenPackets[packet.direction]?.has(packet.name)) return false
  if (filter.query === '') return true

  const matches = filter.regex
    ? filter.regex.test(packet.searchText)
    : packet.searchText.includes(filter.query)

  return filter.inverseFiltering ? !matches : matches
}
