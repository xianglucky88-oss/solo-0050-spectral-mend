import { InputError } from '../http/error.mjs'
import { chunks } from './riff.mjs'
import { format } from './format.mjs'

export function decode(base64) {
  if (typeof base64 !== 'string' || base64.length > 1600000 || base64.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new InputError('音频数据应为有效的 Base64 PCM WAV。')
  const parts = chunks(Buffer.from(base64, 'base64'))
  const { channels, rate, align } = format(parts.get('fmt '))
  const data = parts.get('data')
  const frames = data?.length / align
  if (!Number.isInteger(frames) || frames < 16 || frames > 6 * rate) {
    throw new InputError('音频需含 16 个以上完整采样帧，时长至多 6 秒。')
  }
  const tracks = Array.from({ length: channels }, () => new Float64Array(frames))
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    tracks[c][i] = data.readInt16LE(i * align + c * 2) / 32768
  }
  return { tracks, rate, frames }
}
