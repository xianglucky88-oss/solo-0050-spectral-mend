export function halfAway(value) {
  return value < 0 ? -Math.round(-value) : Math.round(value)
}

export function foldCodes(left, right) {
  const codes = new Int32Array(left.length)
  for (let i = 0; i < left.length; i++) {
    const sum = Math.round(left[i] * 32768) + Math.round(right[i] * 32768)
    codes[i] = sum >= 0 ? (sum + 1) >> 1 : -((1 - sum) >> 1)
  }
  return codes
}

export function encodeMono(codes, rate) {
  const frames = codes.length, size = frames * 2
  const data = Buffer.alloc(44 + size)
  data.write('RIFF', 0); data.writeUInt32LE(data.length - 8, 4); data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16); data.writeUInt16LE(1, 20); data.writeUInt16LE(1, 22)
  data.writeUInt32LE(rate, 24); data.writeUInt32LE(rate * 2, 28)
  data.writeUInt16LE(2, 32); data.writeUInt16LE(16, 34); data.write('data', 36); data.writeUInt32LE(size, 40)
  for (let i = 0; i < frames; i++) {
    data.writeInt16LE(Math.max(-32768, Math.min(32767, codes[i])), 44 + i * 2)
  }
  return data
}
