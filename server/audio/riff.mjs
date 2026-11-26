import { InputError } from '../http/error.mjs'

export function chunks(bytes) {
  if (bytes.length < 12 || bytes.toString('latin1',0,4) !== 'RIFF' || bytes.toString('latin1',8,12) !== 'WAVE') {
    throw new InputError('输入应为 RIFF/WAVE 音频。')
  }
  const end = bytes.readUInt32LE(4) + 8
  if (end !== bytes.length) throw new InputError('WAV 文件长度与头部不一致。')
  const result = new Map()
  let offset = 12
  while (offset + 8 <= end) {
    const name = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    offset = start + size + (size % 2)
    if (offset > end) throw new InputError('WAV 数据块在文件内不完整。')
    if (['fmt ', 'data'].includes(name)) {
      if (result.has(name)) throw new InputError('WAV 含有重复的格式或音频数据块。')
      result.set(name, bytes.subarray(start, start + size))
    }
  }
  if (offset !== end) throw new InputError('WAV 数据块头在文件内不完整。')
  return result
}
