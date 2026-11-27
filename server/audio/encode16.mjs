// 将 PCM16 整数码编码为标准 RIFF/WAVE（双声道交织）。
export function encode16({ channels, rate, codes }) {
  const frames = codes[0].length
  const align = 2 * channels
  const size = frames * align
  const data = Buffer.alloc(44 + size)
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(channels, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * align, 28)
  data.writeUInt16LE(align, 32); data.writeUInt16LE(16, 34)
  data.write('data', 36); data.writeUInt32LE(size, 40)
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    data.writeInt16LE(codes[c][i], 44 + i * align + 2 * c)
  }
  return data
}
