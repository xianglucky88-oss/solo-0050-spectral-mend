import { InputError } from '../http/error.mjs'
import { chunks } from './riff.mjs'
import { format } from './format.mjs'

// 解包为 PCM16 整数码，供房间响应等需要码域精确处理的流程使用。
// minFrames 默认为 16（外部输入音频）；房间响应是本系统产出的受控数据，可短至 1 帧。
export function decodePcm(base64, maxBase64Length = 1600000, { minFrames = 16 } = {}) {
  if (typeof base64 !== 'string' || base64.length > maxBase64Length || base64.length % 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new InputError('音频数据应为有效的 Base64 PCM WAV。')
  const parts = chunks(Buffer.from(base64, 'base64'))
  const { channels, rate, align } = format(parts.get('fmt '))
  const data = parts.get('data')
  const frames = data?.length / align
  if (!Number.isInteger(frames) || frames < minFrames || frames > 6 * rate) {
    throw new InputError('音频需含 16 个以上完整采样帧，时长至多 6 秒。')
  }
  const codes = Array.from({ length: channels }, () => new Int16Array(frames))
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++) {
    codes[c][i] = data.readInt16LE(i * align + c * 2)
  }
  return { rate, frames, channels, codes }
}
