export function createPacketFailureView (packet) {
  const failure = packet.deserializationError || {}

  return {
    status: failure.status || 'Failed to deserialize this packet',
    direction: packet.direction,
    protocolState: packet.meta?.state,
    packetName: packet.meta?.name,
    packetId: packet.hexIdString || 'Unknown',
    receivedLength: failure.receivedLength ?? packet.byteSize ?? 0,
    producedLength: failure.producedLength ?? 'Unavailable because deserialization failed',
    error: failure.message || 'No deserializer error details were provided'
  }
}
