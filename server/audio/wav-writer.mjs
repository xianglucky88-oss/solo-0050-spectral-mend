// 流式 PCM16 WAV 写出。总帧数在开始前已知，因此头部尺寸一次写定，
// 字节布局与 audio/encode.mjs 逐字节一致。尊重下流背压，服务端缓存不膨胀。
export function createWavWriter(target, { rate, channels, frames }) {
  const align = 2 * channels
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + frames * align, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(channels, 22)
  header.writeUInt32LE(rate, 24)
  header.writeUInt32LE(rate * align, 28)
  header.writeUInt16LE(align, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(frames * align, 40)
  let written = 0
  let ready = Promise.resolve()

  function push(chunk, position) {
    ready = ready.then(() => writeChunk(target, chunk, position))
  }
  push(header)
  return {
    writeFrame(samples) {
      const chunk = Buffer.alloc(align)
      for (let c = 0; c < channels; c++) chunk.writeInt16LE(samples[c], 2 * c)
      written++
      push(chunk)
    },
    async finish() {
      await ready
      if (written !== frames) {
        throw new Error(`WAV 写出帧数不一致：期望 ${frames}，实际 ${written}。`)
      }
      if (typeof target.end === 'function') target.end()
      else if (typeof target.close === 'function') await target.close()
      return { frames, bytes: 44 + frames * align }
    }
  }
}

function writeChunk(target, chunk, position) {
  return new Promise((resolve, reject) => {
    const ok = target.write(chunk, err => {
      if (err) reject(err)
    }, position)
    if (ok) resolve()
    else target.once('drain', resolve)
  })
}

// 有限长度收集器（只用于最多十秒的试听扇区）。
export function bufferSink() {
  const parts = []
  return {
    write(chunk) { parts.push(Buffer.from(chunk)); return true },
    async close() {},
    buffer: () => Buffer.concat(parts)
  }
}
