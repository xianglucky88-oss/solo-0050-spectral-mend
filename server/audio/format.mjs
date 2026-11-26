import { InputError } from '../http/error.mjs'

export function format(chunk) {
  if (!chunk || chunk.length < 16) throw new InputError('WAV 没有有效的格式块。')
  const code = chunk.readUInt16LE(0), channels = chunk.readUInt16LE(2), rate = chunk.readUInt32LE(4)
  const byteRate = chunk.readUInt32LE(8), align = chunk.readUInt16LE(12), bits = chunk.readUInt16LE(14)
  if (code !== 1 || bits !== 16 || ![1,2].includes(channels) || rate < 8000 || rate > 48000 ||
      align !== channels * 2 || byteRate !== rate * align) {
    throw new InputError('需要 8–48 kHz、单或双声道的 16 位 PCM WAV。')
  }
  return { channels, rate, align }
}
