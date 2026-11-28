import { decode } from '../audio/decode.mjs'
import { InputError } from '../http/error.mjs'
import { analyzeSegment, peaks } from './analyze.mjs'
import { encodeMono, foldCodes } from './pcm.mjs'
import { buildProduct } from './rescue.mjs'

const FLOOR_MA = 8
const DROP_DB = 9

function stereo(wav) {
  const audio = decode(wav)
  if (audio.tracks.length !== 2) throw new InputError('单声道原件不可启用：需要双声道 PCM 录音。')
  return audio
}

function circle(input, audio) {
  const duration = audio.frames / audio.rate
  const start = input?.start ?? 0
  const end = input?.end ?? duration
  if (![start, end].every(Number.isFinite) || start < 0 || end > duration || end - start < 0.04) {
    throw new InputError('圈选需要 0 到录音结尾之间的起止秒数，长度至少 0.04 秒。')
  }
  return { startFrame: Math.round(start * audio.rate), endFrame: Math.round(end * audio.rate) }
}

function levels(stats) {
  const round = value => Math.round(value * 10) / 10
  return stats.bands.map((band, index) => {
    const left = Math.sqrt(stats.pL[index]) * 32768
    const right = Math.sqrt(stats.pR[index]) * 32768
    const combined = Math.sqrt((stats.pL[index] + stats.pR[index]) / 2) * 32768
    const fold = Math.sqrt(stats.pM[index]) * 32768
    const db = fold >= 0.001 && combined >= 0.001 ? 20 * Math.log10(fold / combined) : null
    let status
    if (combined < FLOOR_MA) status = 'empty'
    else if ((left < FLOOR_MA) !== (right < FLOOR_MA)) status = 'single'
    else if (db === null || db <= -DROP_DB) status = 'cancel'
    else status = 'normal'
    return { index, low: band.low, high: band.high, left: round(left), right: round(right),
      combined: round(combined), fold: round(fold), db: db === null ? null : round(db), status }
  })
}

function segmentStats(audio, startFrame, endFrame) {
  return analyzeSegment(audio.tracks[0], audio.tracks[1], audio.rate, startFrame, endFrame)
}

export function inspect(input) {
  const audio = stereo(input?.wav)
  const { startFrame, endFrame } = circle(input, audio)
  return { rate: audio.rate, frames: audio.frames, channels: 2, duration: audio.frames / audio.rate,
    circle: { start: startFrame / audio.rate, end: endFrame / audio.rate },
    bands: levels(segmentStats(audio, startFrame, endFrame)), peaks: peaks(audio) }
}

export function fold(input) {
  const audio = stereo(input?.wav)
  return { wav: encodeMono(foldCodes(audio.tracks[0], audio.tracks[1]), audio.rate).toString('base64') }
}

export function rescue(input) {
  const audio = stereo(input?.wav)
  const { startFrame, endFrame } = circle(input, audio)
  const stats = segmentStats(audio, startFrame, endFrame)
  const statuses = levels(stats)
  const indices = input?.bands
  if (!Array.isArray(indices) || indices.length === 0 || indices.length > statuses.length ||
      !indices.every(i => Number.isInteger(i) && i >= 0 && i < statuses.length) ||
      new Set(indices).size !== indices.length) {
    throw new InputError('请勾选需要挽回的相消频带。')
  }
  for (const i of indices) {
    if (statuses[i].status !== 'cancel') {
      throw new InputError('只有原来有声且折叠后低至少 9 dB 的双侧有声频带可勾选挽回。')
    }
  }
  const product = buildProduct(audio, startFrame, endFrame, indices, stats)
  return { wav: encodeMono(product.codes, audio.rate).toString('base64'),
    verify: product.verify, saturation: product.saturation }
}
