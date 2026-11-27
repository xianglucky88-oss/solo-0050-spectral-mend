import { decode } from '../audio/decode.mjs'
import { InputError } from '../http/error.mjs'

// 工作台除了沿用 Base64 PCM WAV 字符串外，也接受 Buffer / 类型化数组 /
// 普通 `{ rate, tracks }` 结构，方便程序化检查直接喂入样点。
export function decodeAudioAny(source) {
  if (source === undefined || source === null) throw new InputError('缺少音频数据。')
  if (typeof source === 'string') {
    const base64 = source.startsWith('data:') ? source.slice(source.indexOf(',') + 1) : source
    return decode(base64)
  }
  if (Buffer.isBuffer(source)) return decode(source.toString('base64'))
  if (source instanceof Uint8Array) return decode(Buffer.from(source).toString('base64'))
  if (source instanceof ArrayBuffer) return decode(Buffer.from(new Uint8Array(source)).toString('base64'))
  if (ArrayBuffer.isView(source) && typeof source.length === 'number') {
    return decode(Buffer.from(source.buffer, source.byteOffset, source.byteLength).toString('base64'))
  }
  if (typeof source === 'object') return audioFromObject(source)
  throw new InputError('无法识别的音频数据，应为 PCM16 WAV。')
}

function asTrack(value) {
  if (value instanceof Float64Array) return value
  if (value instanceof Float32Array) return Float64Array.from(value)
  if (ArrayBuffer.isView(value)) return Float64Array.from(value)
  if (Array.isArray(value)) return Float64Array.from(value)
  return null
}

function audioFromObject(object) {
  const rate = Number(object.rate ?? object.sampleRate ?? object.hz ?? object.frequency)
  if (!Number.isFinite(rate) || rate < 8000 || rate > 48000) {
    throw new InputError('需要 8–48 kHz 的音频。')
  }
  let tracks = null
  const candidate = object.tracks ?? object.channelData ?? object.channels ?? object.samples
  if (Array.isArray(candidate)) {
    if (candidate.length && Array.isArray(candidate[0]) || candidate[0] instanceof Float64Array ||
        candidate[0] instanceof Float32Array || ArrayBuffer.isView(candidate[0])) {
      tracks = candidate.map(asTrack)
    } else if (typeof candidate[0] === 'number') {
      const channelCount = Number(object.channelCount ?? object.channel ?? 2)
      const interleaved = object.interleaved !== false
      if (channelCount === 1) tracks = [asTrack(candidate)]
      else if (interleaved) {
        const frames = Math.floor(candidate.length / channelCount)
        tracks = Array.from({ length: channelCount }, () => new Float64Array(frames))
        for (let i = 0; i < frames; i++) for (let c = 0; c < channelCount; c++) {
          tracks[c][i] = candidate[i * channelCount + c]
        }
      } else {
        tracks = Array.from({ length: channelCount }, (_, c) =>
          asTrack(candidate.slice(c * Math.floor(candidate.length / channelCount),
            (c + 1) * Math.floor(candidate.length / channelCount))))
      }
    }
  }
  if ((!tracks || tracks.some(t => !t)) && object.pcm) return audioFromObject({ ...object, samples: object.pcm })
  if (!tracks || !tracks.length) throw new InputError('音频对象缺少声道样点。')
  let frames = Number(object.frames ?? object.frameCount ?? object.length ?? tracks[0].length)
  if (!Number.isFinite(frames)) frames = tracks[0].length
  frames = Math.min(frames, ...tracks.map(t => t.length))
  // 明显的整数 PCM16 量纲（峰值超过 2）时归一化到 -1..1。
  const peak = tracks.reduce((m, t) => {
    let p = m
    for (let i = 0; i < Math.min(t.length, frames); i++) p = Math.max(p, Math.abs(t[i]))
    return p
  }, 0)
  if (peak > 2) for (const t of tracks) for (let i = 0; i < t.length; i++) t[i] /= 32768
  tracks = tracks.map(t => t.length === frames ? t : t.slice(0, frames))
  return { tracks, rate, frames }
}

// 等长替换声音：接受 Base64 WAV 或音频对象，返回与目标帧数一致的音轨。
export function replacementTracks(sourceAudio, replacement, expectedFrames) {
  const audio = decodeAudioAny(replacement)
  let tracks = audio.tracks
  if (tracks.length !== sourceAudio.tracks.length) {
    if (tracks.length === 1 && sourceAudio.tracks.length === 2) tracks = [tracks[0], Float64Array.from(tracks[0])]
    else if (sourceAudio.tracks.length === 1) tracks = [tracks[0]]
    else {
      const merged = new Float64Array(audio.frames)
      for (const t of tracks) for (let i = 0; i < audio.frames; i++) merged[i] += t[i] / tracks.length
      tracks = sourceAudio.tracks.map(() => Float64Array.from(merged))
    }
  }
  if (audio.frames === expectedFrames) return tracks
  // 帧数不一致时做线性重采样到等长，保证接头位置与拼接帧数不变。
  const ratio = audio.frames / expectedFrames
  return tracks.map(track => {
    const out = new Float64Array(expectedFrames)
    for (let i = 0; i < expectedFrames; i++) {
      const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(audio.frames - 1, i0 + 1), frac = pos - i0
      out[i] = (track[i0] ?? 0) * (1 - frac) + (track[i1] ?? 0) * frac
    }
    return out
  })
}
