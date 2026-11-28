import { InputError } from '../http/error.mjs'
import { MIN_FRAMES, MAX_SECONDS } from './limits.mjs'

async function readExact(handle, buffer, offset, length, position) {
  const got = await handle.read(buffer, offset, length, position)
  if (got.bytesRead !== length) throw new InputError('WAV 数据块在文件内不完整。')
}

// 只读取 RIFF 头部与块目录，不把音频载荷载入内存。
// 返回格式参数、data 块位置与完整性标记：数据截在帧中间或文件被截断时 complete=false。
export async function scanWav(handle, fileSize) {
  const head = Buffer.alloc(12)
  await readExact(handle, head, 0, 12, 0)
  if (head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE') {
    throw new InputError('输入应为 RIFF/WAVE 音频。')
  }
  const riffEnd = head.readUInt32LE(4) + 8
  // RIFF 尺寸超出实际文件通常意味着 data 块被截断，交给后面的完整帧判定，
  // 其他头部块的截断仍在循环里拒绝。
  const directory = Buffer.alloc(8)
  let offset = 12, fmt = null, data = null
  while (offset + 8 <= fileSize) {
    await readExact(handle, directory, 0, 8, offset)
    const name = directory.toString('latin1', 0, 4)
    const size = directory.readUInt32LE(4)
    const start = offset + 8
    if (start + size > fileSize) {
      if (name === 'data') { data = { offset: start, declared: size }; break }
      throw new InputError('WAV 数据块在文件内不完整。')
    }
    offset = start + size + (size % 2)
    if (name === 'fmt ' || name === 'data') {
      if (name === 'fmt ' && fmt) throw new InputError('WAV 含有重复的格式块。')
      if (name === 'data' && data) throw new InputError('WAV 含有重复的音频数据块。')
      if (name === 'fmt ') {
        const chunk = Buffer.alloc(Math.min(size, 40))
        await readExact(handle, chunk, 0, chunk.length, start)
        fmt = parseFormat(chunk)
      } else {
        data = { offset: start, declared: size }
      }
    }
  }
  if (!fmt) throw new InputError('WAV 没有有效的格式块。')
  if (!data) throw new InputError('WAV 缺少音频数据块。')
  const available = Math.min(data.declared, fileSize - data.offset)
  const align = fmt.channels * 2
  const complete = available === data.declared && available % align === 0
  const frames = Math.floor(available / align)
  if (!complete) {
    return { ...fmt, frames, dataOffset: data.offset, complete: false }
  }
  if (frames < MIN_FRAMES) throw new InputError('音频需含 16 个以上完整采样帧。')
  if (frames > MAX_SECONDS * fmt.rate) throw new InputError('录音时长不能超过五分钟。')
  return { ...fmt, frames, dataOffset: data.offset, complete: true }
}

function parseFormat(chunk) {
  if (chunk.length < 16) throw new InputError('WAV 没有有效的格式块。')
  const code = chunk.readUInt16LE(0), channels = chunk.readUInt16LE(2), rate = chunk.readUInt32LE(4)
  const byteRate = chunk.readUInt32LE(8), align = chunk.readUInt16LE(12), bits = chunk.readUInt16LE(14)
  if (code !== 1 || bits !== 16 || ![1, 2].includes(channels) || rate < 8000 || rate > 48000 ||
      align !== channels * 2 || byteRate !== rate * align) {
    throw new InputError('需要 8–48 kHz、单或双声道的 16 位 PCM WAV。')
  }
  return { channels, rate, align }
}

// 按需读取 [first, first+count) 采样帧，工作缓存只覆盖请求的小段。
export async function readFrames(handle, info, first, count) {
  const { channels, align, dataOffset, frames } = info
  const clamped = Math.max(0, Math.min(count, frames - first))
  const bytes = Buffer.alloc(clamped * align)
  if (clamped > 0) await readExact(handle, bytes, 0, bytes.length, dataOffset + first * align)
  const tracks = Array.from({ length: channels }, () => new Float64Array(clamped))
  for (let i = 0; i < clamped; i++) for (let c = 0; c < channels; c++) {
    tracks[c][i] = bytes.readInt16LE(i * align + c * 2) / 32768
  }
  return { tracks, count: clamped }
}
