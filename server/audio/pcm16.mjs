// 直接在 PCM16 整数刻度上工作的 WAV 编解码，保证“减半 + 工作台舍入”逐样值可验。
import { workbenchRound, clampPcm16, PCM_FULL_SCALE } from '../repair/flattops.mjs'

export { workbenchRound, clampPcm16 }

// 从 Base64 PCM WAV 解出整数声道（与 server/audio/decode.mjs 同一套 RIFF 约束的轻量读取）。
export function decodePcm16(base64) {
  if (typeof base64 !== 'string') throw new TypeError('wav 必须是 Base64 字符串。')
  const bytes = Buffer.from(base64, 'base64')
  if (bytes.length < 44 || bytes.toString('latin1', 0, 4) !== 'RIFF' ||
      bytes.toString('latin1', 8, 12) !== 'WAVE') {
    throw new Error('输入应为 RIFF/WAVE 音频。')
  }
  let offset = 12
  let fmt = null
  let data = null
  const end = bytes.readUInt32LE(4) + 8
  while (offset + 8 <= end) {
    const name = bytes.toString('latin1', offset, offset + 4)
    const size = bytes.readUInt32LE(offset + 4)
    const start = offset + 8
    if (name === 'fmt ') fmt = bytes.subarray(start, start + size)
    if (name === 'data') data = bytes.subarray(start, start + size)
    offset = start + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('WAV 缺少格式块或数据块。')
  const channels = fmt.readUInt16LE(2)
  const rate = fmt.readUInt32LE(4)
  const bits = fmt.readUInt16LE(14)
  if (bits !== 16 || (channels !== 1 && channels !== 2)) throw new Error('需要 16 位单/双声道 PCM WAV。')
  const align = channels * 2
  const frames = Math.floor(data.length / align)
  const pcm = Array.from({ length: channels }, () => new Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) pcm[c][i] = data.readInt16LE(i * align + c * 2)
  }
  return { pcm, tracks: pcm.map(channel => Float64Array.from(channel, v => v / PCM_FULL_SCALE)),
    rate, frames, channels }
}

// pcm：整数样值声道数组。写出标准 44 字节头的 PCM16 WAV Buffer。
export function encodePcm16Wav({ pcm, rate = 16000 }) {
  const channels = pcm.length
  const frames = pcm[0]?.length ?? 0
  const align = 2 * channels
  const size = frames * align
  const data = Buffer.alloc(44 + size)
  data.write('RIFF', 0)
  data.writeUInt32LE(data.length - 8, 4)
  data.write('WAVEfmt ', 8)
  data.writeUInt32LE(16, 16)
  data.writeUInt16LE(1, 20)
  data.writeUInt16LE(channels, 22)
  data.writeUInt32LE(rate, 24)
  data.writeUInt32LE(rate * align, 28)
  data.writeUInt16LE(align, 32)
  data.writeUInt16LE(16, 34)
  data.write('data', 36)
  data.writeUInt32LE(size, 40)
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) {
      data.writeInt16LE(clampPcm16(Math.round(pcm[c][i])), 44 + i * align + 2 * c)
    }
  }
  return data
}

// 工作台规则的归一化浮点版本：v -> round(v*32768) 夹取。
export function quantizeWorkbench(value) {
  return workbenchRound(value * PCM_FULL_SCALE)
}
