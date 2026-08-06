import { hexy } from 'hexy'
import { rawBytes } from './rawData.js'

const HEX_DUMP_OPTIONS = {
  bytesPerLine: 8,
  bytesPerGroup: 1,
  caps: 'upper',
  annotate: 'ascii'
}

export function formatHexDump (raw) {
  const bytes = rawBytes(raw)
  if (bytes.length === 0) return 'No raw packet data available.'

  // hexy 0.4.0 accepts number arrays without passing binary bytes through a
  // text decoder. Replacing DEL keeps the ASCII column consistently printable.
  return hexy(Array.from(bytes), HEX_DUMP_OPTIONS).replace(/\x7f/g, '.')
}
