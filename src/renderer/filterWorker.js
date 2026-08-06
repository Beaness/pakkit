import { createFilter, createPacketSearchText, packetIsVisible } from './filteringCore.mjs'

const packets = []
const packetTypeCounts = {
  serverbound: new Map(),
  clientbound: new Map()
}

let filterRevision = 0
let filterJob = 0
let filter = createFilter('', false, false, { serverbound: [], clientbound: [] })

function incrementPacketTypeCount (packet) {
  const counts = packetTypeCounts[packet.direction]
  if (!counts) return
  counts.set(packet.name, (counts.get(packet.name) || 0) + 1)
}

function getHiddenPacketCount () {
  let count = 0
  for (const direction of ['serverbound', 'clientbound']) {
    for (const name of filter.hiddenPackets[direction]) {
      count += packetTypeCounts[direction].get(name) || 0
    }
  }
  return count
}

function postVisibleIds (type, ids, extra = {}) {
  const visibleIds = Uint32Array.from(ids)
  self.postMessage({
    type,
    revision: filterRevision,
    visibleIds,
    hiddenCount: getHiddenPacketCount(),
    ...extra
  }, [visibleIds.buffer])
}

function addPackets (newPackets) {
  const visibleIds = []

  for (const packet of newPackets) {
    const indexedPacket = {
      uid: packet.uid,
      direction: packet.direction,
      name: packet.name,
      searchText: createPacketSearchText(packet)
    }
    packets[indexedPacket.uid] = indexedPacket
    incrementPacketTypeCount(indexedPacket)

    if (packetIsVisible(indexedPacket, filter)) visibleIds.push(indexedPacket.uid)
  }

  postVisibleIds('appendResult', visibleIds)
}

function startFilter (message) {
  filterRevision = message.revision
  filter = createFilter(message.query, message.inverseFiltering, message.regexFilter, message.hiddenPackets)

  const job = ++filterJob
  const packetCount = packets.length
  const visibleIds = []
  let index = 0

  function filterChunk () {
    if (job !== filterJob) return

    const deadline = performance.now() + 8
    while (index < packetCount && performance.now() < deadline) {
      const packet = packets[index]
      if (packet && packetIsVisible(packet, filter)) visibleIds.push(packet.uid)
      index++
    }

    if (index < packetCount) {
      setTimeout(filterChunk, 0)
      return
    }

    postVisibleIds('filterResult', visibleIds, { packetCount })
  }

  filterChunk()
}

function reset (message) {
  filterJob++
  filterRevision = message.revision
  filter = createFilter(message.query, message.inverseFiltering, message.regexFilter, message.hiddenPackets)
  packets.length = 0
  packetTypeCounts.serverbound.clear()
  packetTypeCounts.clientbound.clear()
}

self.addEventListener('message', (event) => {
  const message = event.data
  if (message.type === 'add') {
    addPackets(message.packets)
  } else if (message.type === 'filter') {
    startFilter(message)
  } else if (message.type === 'reset') {
    reset(message)
  }
})
