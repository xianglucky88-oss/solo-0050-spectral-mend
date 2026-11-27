import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { selection } from './selection.mjs'
import { calibrateDirection, globalPeakOf } from './calibrate.mjs'
import { restoreProgram, bleedMetrics, maxPcmDifference } from './restore.mjs'
import { sumAbs } from './linalg.mjs'

/** 节目同路同帧还原 PCM16 相差超过该码值即视为歧义。 */
export const AMBIGUITY_CODES = 64

const DIRECTIONS = [
  { id: 'L→R', source: 0, victim: 1, solo: 0, label: '左声道独奏串入右声道' },
  { id: 'R→L', source: 1, victim: 0, solo: 1, label: '右声道独奏串入左声道' }
]

function tapsToArray(taps) {
  return taps ? Array.from(taps, value => Math.fround(value)) : null
}

function describeDirection(direction, result) {
  return {
    id: direction.id,
    label: direction.label,
    source: direction.source,
    victim: direction.victim,
    status: result.status,
    support: result.support,
    adopted: result.adopted,
    adoptedSegments: result.adoptedSegments,
    voiced: result.voiced,
    filter: tapsToArray(result.filter),
    gain: result.filter ? sumAbs(result.filter) : null,
    score: result.score,
    maxErrorRatio: result.maxErrorRatio,
    message: result.message ?? null
  }
}

function describeAudio(audio) {
  return { rate: audio.rate, frames: audio.frames, channels: audio.tracks.length }
}

function describeProgram(program) {
  return { start: program.start, end: program.end, startFrame: program.startFrame, endFrame: program.endFrame }
}

function explanationFilter(entry) {
  return entry.taps ?? entry.filter
}

/**
 * 固定另一方向，比较本方向各最大支持解释下的节目还原。
 *
 * 把本方向每个解释与另一方向采用滤波器组合成两组抽头：左→右（hLR）与
 * 右→左（hRL），逐帧还原节目，取所有解释之间同路同帧 PCM16 的最大差。
 * 相差超过 64 码即判该方向歧义，并记录涉及声道与帧号。
 */
function ambiguityOf(direction, result, otherResult, audio, program) {
  const ownFilters = [result.filter, ...result.explanations.map(explanationFilter)]
  const otherFilter = otherResult.filter
  if (ownFilters.length < 2) return { ambiguous: false, maxDifference: 0, channel: null, frame: null }

  const restored = ownFilters.map(taps => {
    const hLR = direction.id === 'L→R' ? taps : otherFilter
    const hRL = direction.id === 'L→R' ? otherFilter : taps
    return restoreProgram(audio, program, hRL, hLR)
  })
  let difference = 0, channel = null, frame = null
  for (let i = 0; i < restored.length; i++) {
    for (let j = i + 1; j < restored.length; j++) {
      const { amount, atChannel, atFrame } = maxPcmDifference(restored[i], restored[j], program)
      if (amount > difference) { difference = amount; channel = atChannel; frame = atFrame }
    }
  }
  return { ambiguous: difference > AMBIGUITY_CODES, maxDifference: difference, channel, frame }
}

/**
 * 校准区与圈外逐样保留：节目区间外的每一帧两路都必须等于观测值。
 */
function preservedReport(audio, output, program) {
  let preserved = true
  for (let channel = 0; channel < audio.tracks.length; channel++) {
    for (let n = 0; n < audio.frames; n++) {
      if (n >= program.startFrame && n < program.endFrame) continue
      if (output[channel][n] !== audio.tracks[channel][n]) { preserved = false; break }
    }
    if (!preserved) break
  }
  return { calibrationAndOutsidePreserved: preserved,
    preservedFrames: audio.frames - (program.endFrame - program.startFrame) }
}

/**
 * 串漏校准与还原。
 *
 * 每方向只用该方向独奏圈内的段，拟合固定延迟关系。任一方向缺证（有声
 * 不足两段）、校准不一致（至少两段却无法互证）或歧义（固定另一方向后，
 * 最大支持的不同解释使节目同路同帧还原 PCM16 相差超过 64 码）时，保留
 * 原声、不出成品，并指出方向。全部通过才去掉待修节目内传入的串漏；
 * 校准区与圈外逐样保留，成品与原采样率、帧数、声道顺序一致。
 */
export function calibrate(input) {
  const audio = decode(input?.wav)
  const { solos, program } = selection(input, audio)
  const globalPeak = globalPeakOf(audio.tracks)

  const results = {}
  const directions = {}
  for (const direction of DIRECTIONS) {
    const result = calibrateDirection(audio.tracks[direction.source], audio.tracks[direction.victim],
      solos[direction.solo], globalPeak)
    results[direction.id] = result
    directions[direction.id] = describeDirection(direction, result)
  }

  const issues = []
  for (const direction of DIRECTIONS) {
    const result = results[direction.id]
    if (result.status === 'insufficient') {
      issues.push({ direction: direction.id, kind: 'insufficient-evidence',
        message: `方向 ${direction.id}：${result.message}` })
    } else if (result.status === 'inconsistent') {
      issues.push({ direction: direction.id, kind: 'inconsistent-calibration',
        message: `方向 ${direction.id}：${result.message}` })
    }
  }
  const summary = { directions, program: describeProgram(program), audio: describeAudio(audio) }
  if (issues.length > 0) return { status: 'error', restored: false, wav: null, issues, ...summary }

  // 两个方向都通过后才评估节目还原歧义（需要固定另一方向）。
  for (const direction of DIRECTIONS) {
    const other = DIRECTIONS.find(entry => entry.id !== direction.id)
    const ambiguity = ambiguityOf(direction, results[direction.id], results[other.id], audio, program)
    directions[direction.id].ambiguous = ambiguity.ambiguous
    directions[direction.id].maxExplanationDifference = ambiguity.maxDifference
    if (ambiguity.channel !== null) {
      directions[direction.id].ambiguousChannel = ambiguity.channel
      directions[direction.id].ambiguousFrame = ambiguity.frame
    }
    if (ambiguity.ambiguous) {
      issues.push({ direction: direction.id, kind: 'ambiguous',
        message: `方向 ${direction.id}：固定另一方向后，合格解释使节目第 ${ambiguity.channel + 1} 路第 ${ambiguity.frame} 帧的还原 PCM16 相差 ${ambiguity.maxDifference} 码，超过 ${AMBIGUITY_CODES} 码。` })
    }
  }
  if (issues.length > 0) return { status: 'error', restored: false, wav: null, issues, ...summary }

  const output = restoreProgram(audio, program, results['R→L'].filter, results['L→R'].filter)
  return {
    status: 'ok',
    restored: true,
    wav: encode({ tracks: output, rate: audio.rate, frames: audio.frames }).toString('base64'),
    issues: [],
    ...summary,
    metrics: bleedMetrics(audio.tracks, output, program),
    preserved: preservedReport(audio, output, program)
  }
}
