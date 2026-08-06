import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { deflateSync } from 'node:zlib'

import { captureRawPacket, observeRawPackets } from '../src/proxy/java/rawPacketCapture.mjs'
import { createPacketFailureView } from '../src/renderer/packetFailureView.mjs'

function fakeClient (parsePacketBuffer) {
  return {
    state: 'play',
    decompressor: null,
    splitter: new EventEmitter(),
    deserializer: { parsePacketBuffer }
  }
}

test('the raw observer reports packets even when deserialization fails', () => {
  const client = fakeClient(() => {
    throw new Error('Unexpected end of packet')
  })
  const captured = []

  observeRawPackets(client, () => ({ '0x01': 'spawn_entity' }), packet => captured.push(packet))
  client.splitter.emit('data', Buffer.from([0x01, 0xaa, 0xbb]))

  assert.equal(captured.length, 1)
  assert.equal(captured[0].meta.name, 'spawn_entity')
  assert.deepEqual(captured[0].raw, Buffer.from([0x01, 0xaa, 0xbb]))
  assert.equal(captured[0].deserializationError.status, 'Failed to deserialize this packet')
  assert.equal(captured[0].deserializationError.receivedLength, 3)
  assert.equal(captured[0].deserializationError.producedLength, null)
})

test('compressed packets are decompressed for RAW forwarding and inspection', () => {
  const raw = Buffer.from([0x01, 0xaa, 0xbb])
  const compressed = deflateSync(raw)
  const encoded = Buffer.concat([Buffer.from([raw.length]), compressed])
  const client = fakeClient(() => ({
    data: { name: 'spawn_entity', params: { entityId: 7 } },
    metadata: { size: raw.length }
  }))
  client.decompressor = {}

  const packet = captureRawPacket(client, encoded, () => ({}))

  assert.deepEqual(packet.raw, raw)
  assert.deepEqual(packet.data, { entityId: 7 })
  assert.equal(packet.sizeInfo.wasCompressed, true)
  assert.equal(packet.sizeInfo.compressedByteSize, encoded.length)
})

test('failed packet JSON details explain unavailable produced length', () => {
  const view = createPacketFailureView({
    direction: 'clientbound',
    meta: { state: 'play', name: 'spawn_entity' },
    hexIdString: '0x01',
    byteSize: 3,
    deserializationError: {
      status: 'Failed to deserialize this packet',
      message: 'Unexpected end of packet',
      receivedLength: 3,
      producedLength: null
    }
  })

  assert.deepEqual(view, {
    status: 'Failed to deserialize this packet',
    direction: 'clientbound',
    protocolState: 'play',
    packetName: 'spawn_entity',
    packetId: '0x01',
    receivedLength: 3,
    producedLength: 'Unavailable because deserialization failed',
    error: 'Unexpected end of packet'
  })
})
