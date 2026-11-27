// PCM16 整数刻度编解码：落锁搬迁要求“双路原码”逐码一致，
// 因此核心引擎直接在有符号 16 位整数样点上工作，避免浮点往返歧义。
import { InputError } from '../http/error.mjs'
import { chunks } from './riff.mjs'
import { format } from './format.mjs'

export function decodePcm16(input) {
  let bytes
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) bytes = Buffer.from(input)
  else if (input instanceof ArrayBuffer) bytes = Buffer.from(input)
  else if (typeof input === 'string') bytes = Buffer.from(input, 'base64')
  else throw new InputError('音频数据应为 Base64 PCM WAV。')
  const parts = chunks(bytes)
  const { channels, rate, align } = format(parts.get('fmt '))
  const data = parts.get('data')
  const frames = data?.length / align
  if (!Number.isInteger(frames) || frames < 16 || frames > 6 * rate) {
    throw new InputError('音频需含 16 个以上完整采样帧，时长至多 6 秒。')
  }
  const pcm = Array.from({ length: channels }, () => new Array(frames))
  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < channels; c++) pcm[c][i] = data.readInt16LE(i * align + c * 2)
  }
  return { pcm, channels, rate, frames }
}

// 与 server/audio/encode.mjs 相同的 44 字节标准 PCM WAV 布局，
// 但直接写入整数，不做浮点缩放。
export function encodePcm16Wav({ pcm, rate }) {
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
      let value = Math.round(pcm[c][i])
      if (value > 32767) value = 32767
      else if (value < -32768) value = -32768
      data.writeInt16LE(value, 44 + i * align + 2 * c)
    }
  }
  return data
}

// 既有浮点音轨（-1..1）转整数刻度，供纯引擎在非 WAV 入参时使用。
export function tracksToPcm16(tracks) {
  return tracks.map(track => Array.from(track, value => {
    let v = Math.round(value * 32768)
    if (v > 32767) v = 32767
    else if (v < -32768) v = -32768
    return v
  }))
}

export function pcm16ToTracks(pcm) {
  return pcm.map(channel => Float64Array.from(channel, value => value / 32768))
}
