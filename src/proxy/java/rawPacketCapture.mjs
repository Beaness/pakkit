import { unzipSync } from 'node:zlib'

function readVarInt (buffer) {
  let value = 0

  for (let index = 0; index < Math.min(buffer.length, 5); index++) {
    const byte = buffer[index]
    value += (byte & 0x7f) * Math.pow(2, 7 * index)
    if ((byte & 0x80) === 0) {
      return { value, size: index + 1 }
    }
  }

  throw new Error('Packet starts with an incomplete VarInt')
}

function packetIdFromRaw (raw) {
  try {
    return readVarInt(raw).value
  } catch {
    return undefined
  }
}

function decodeRawPacket (encoded, compressionEnabled) {
  if (!compressionEnabled) {
    return {
      raw: encoded,
      wasCompressed: false
    }
  }

  const header = readVarInt(encoded)
  if (header.value === 0) {
    return {
      raw: encoded.subarray(header.size),
      wasCompressed: false
    }
  }

  return {
    raw: unzipSync(encoded.subarray(header.size), { finishFlush: 2 }),
    wasCompressed: true
  }
}

function errorMessage (error) {
  return error?.message || String(error)
}

export function captureRawPacket (protocolClient, encoded, getMappings) {
  const state = protocolClient.state
  const compressionEnabled = protocolClient.decompressor !== null
  let decoded

  try {
    decoded = decodeRawPacket(encoded, compressionEnabled)
  } catch (error) {
    return {
      data: undefined,
      meta: { state, name: 'unknown' },
      raw: encoded,
      packetValid: false,
      rawEncoding: compressionEnabled ? 'compressed' : 'uncompressed',
      sizeInfo: {
        wasCompressed: compressionEnabled,
        compressedByteSize: encoded.length
      },
      deserializationError: {
        status: 'Failed to deserialize this packet',
        message: errorMessage(error),
        receivedLength: encoded.length,
        producedLength: null
      }
    }
  }

  const { raw, wasCompressed } = decoded
  const packetId = packetIdFromRaw(raw)

  try {
    const parsed = protocolClient.deserializer.parsePacketBuffer(raw)
    return {
      data: parsed.data.params,
      meta: {
        ...parsed.metadata,
        state,
        name: parsed.data.name
      },
      raw,
      packetValid: true,
      rawEncoding: 'uncompressed',
      sizeInfo: {
        wasCompressed,
        compressedByteSize: wasCompressed ? encoded.length : raw.length
      }
    }
  } catch (error) {
    const id = packetId === undefined
      ? undefined
      : '0x' + packetId.toString(16).padStart(2, '0')
    const name = id === undefined ? 'unknown' : getMappings(state)?.[id]

    return {
      data: undefined,
      meta: { state, name: name ?? packetId ?? 'unknown' },
      raw,
      packetValid: false,
      rawEncoding: 'uncompressed',
      sizeInfo: {
        wasCompressed,
        compressedByteSize: wasCompressed ? encoded.length : raw.length
      },
      deserializationError: {
        status: 'Failed to deserialize this packet',
        message: errorMessage(error),
        receivedLength: raw.length,
        producedLength: null
      }
    }
  }
}

// The splitter sees every complete wire packet before minecraft-protocol tries
// to deserialize it. Capturing here ensures a malformed packet is still handed
// to the proxy route even though no decoded `packet`/`raw` event will follow.
export function observeRawPackets (protocolClient, getMappings, onPacket) {
  const listener = encoded => {
    onPacket(captureRawPacket(protocolClient, encoded, getMappings))
  }

  protocolClient.splitter.prependListener('data', listener)
  return () => protocolClient.splitter.removeListener('data', listener)
}

export function isPacketParseError (error) {
  return Buffer.isBuffer(error?.buffer) && error?.message?.startsWith('Parse error for ')
}
