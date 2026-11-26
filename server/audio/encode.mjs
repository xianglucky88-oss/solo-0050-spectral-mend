export function encode({ tracks, rate, frames }) {
  const channels = tracks.length, align = 2 * channels, size = frames * align
  const data = Buffer.alloc(44 + size)
  data.write('RIFF',0); data.writeUInt32LE(data.length - 8,4); data.write('WAVEfmt ',8)
  data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(channels,22)
  data.writeUInt32LE(rate,24); data.writeUInt32LE(rate * align,28)
  data.writeUInt16LE(align,32); data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(size,40)
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    const value = Math.max(-32768, Math.min(32767, Math.round(tracks[c][i] * 32768)))
    data.writeInt16LE(value, 44 + i * align + 2 * c)
  }
  return data
}
