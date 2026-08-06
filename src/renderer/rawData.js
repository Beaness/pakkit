export function rawBytes (raw) {
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw.slice(0))

  if (ArrayBuffer.isView(raw)) {
    const view = new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
    return Uint8Array.from(view)
  }

  // Buffers cross the JSON-based IPC boundary in Node's toJSON shape.
  const values = raw?.type === 'Buffer' ? raw.data : raw
  if (!Array.isArray(values)) return new Uint8Array()

  return Uint8Array.from(values)
}

export function normalizePacketRaw (packet) {
  if (!packet) return packet

  const values = packet.raw?.type === 'Buffer' ? packet.raw.data : packet.raw
  packet.raw = Array.isArray(values) ? values : Array.from(rawBytes(values))
  return packet
}
