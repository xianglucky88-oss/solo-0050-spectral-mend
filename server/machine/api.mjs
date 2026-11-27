import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { InputError } from '../http/error.mjs'
import { fitCalibration, CalibrationRejected } from './calibrate.mjs'
import { renderCancel, renderAlignedReference } from './cancel.mjs'
import { coverageInterval } from './geometry.mjs'

export { CalibrationRejected }

function pick(input, names) {
  for (const name of names) {
    const value = input?.[name]
    if (value !== undefined && value !== null) return value
  }
  return undefined
}

function wavString(value) {
  if (typeof value === 'string') return value
  if (value && typeof value.wav === 'string') return value.wav
  return undefined
}

// 允许直接传入已解码的 { tracks, rate, frames }（Node 工作流自检风格）。
function asAudio(value) {
  if (value && Array.isArray(value.tracks) && Number.isFinite(value.rate) && Number.isFinite(value.frames)) return value
  return undefined
}

function decodeMain(input) {
  const value = pick(input, ['wav', 'mainWav', 'main', 'audio', 'mainAudio'])
  const direct = asAudio(value) ?? asAudio(input?.audio) ?? asAudio(input?.mainAudio)
  if (direct) return { audio: direct, wav: wavString(value) }
  return { audio: decode(wavString(value)), wav: wavString(value) }
}

function decodeReference(input) {
  const value = pick(input, ['referenceWav', 'reference', 'refWav', 'ref', 'machineWav', 'referenceAudio'])
  const direct = asAudio(value) ?? asAudio(input?.referenceAudio)
  if (direct) return { audio: direct, wav: wavString(value) }
  const wav = wavString(value)
  if (!wav) throw new InputError('请提供同一台机器的单声道参考录音。')
  return { audio: decode(wav), wav }
}

function normalizeRange(r) {
  if (!r) return r
  if (Number.isFinite(r.start) && Number.isFinite(r.end)) return { start: Number(r.start), end: Number(r.end) }
  return r
}

// 识别前后两段校准区，兼容数组或 first/second 命名。
export function calibrationRanges(input) {
  const direct = pick(input, ['calibrationRanges', 'calibrationZones', 'calZones',
    'calibrations', 'zones', 'ranges', 'sampleRanges', 'anchors'])
  const calObject = pick(input, ['calibration', 'cal'])
  let pair
  if (Array.isArray(direct) && direct.length >= 2) pair = [direct[0], direct[1]]
  else if (calObject && Array.isArray(calObject.ranges) && calObject.ranges.length >= 2) pair = calObject.ranges
  else if (calObject && Array.isArray(calObject.segments) && calObject.segments.length >= 2) pair = calObject.segments
  else {
    const first = pick(input, ['first', 'before', 'zoneA', 'range1', 'firstRange', 'front', 'anchor1'])
    const second = pick(input, ['second', 'after', 'zoneB', 'range2', 'secondRange', 'back', 'anchor2'])
    pair = [first, second]
  }
  if (!pair[0] || !pair[1]) throw new InputError('请在主录音前后各圈选一段纯机器声作为校准区。')
  return pair.map(r => {
    const range = normalizeRange(r)
    if (Number.isFinite(range.start) && Number.isFinite(range.end)) return range
    const sf = r.startFrame ?? r.startSample ?? r.aFrame
    const ef = r.endFrame ?? r.endSample ?? r.bFrame
    const rate = input.rate ?? input.mainRate
    if (Number.isFinite(sf) && Number.isFinite(ef) && rate) return { start: sf / rate, end: ef / rate }
    return { start: Number(sf), end: Number(ef) }
  })
}

function repairRanges(input) {
  let value = pick(input, ['repairs', 'repairRanges', 'repairRegions', 'repairZones',
    'cancelRanges', 'muteRanges', 'cancellationRanges', 'mends', 'targets', 'intervals', 'regions'])
  if (value === undefined) {
    const single = pick(input, ['repair', 'mend', 'region'])
    value = single ? [single] : []
  }
  if (!Array.isArray(value)) throw new InputError('修复区应为开始/结束区间数组。')
  return value.map(r => {
    const range = normalizeRange(r)
    if (Number.isFinite(range.start) && Number.isFinite(range.end)) return range
    const sf = r.startFrame ?? r.startSample
    const ef = r.endFrame ?? r.endSample
    const rate = input.rate ?? input.mainRate
    return { start: rate ? sf / rate : Number(sf), end: rate ? ef / rate : Number(ef) }
  })
}

function resolveCalibration(input, main, reference) {
  const provided = pick(input, ['calibration', 'cal'])
  const rho = Number(input.rho ?? provided?.rho)
  const delta = Number(input.delta ?? provided?.delta ?? provided?.deltaSamples)
  const gains = input.gains ?? provided?.gains
  if (Number.isFinite(rho) && Number.isFinite(delta) && Array.isArray(gains)) {
    return { rho, delta, gains: gains.map(Number) }
  }
  const ranges = calibrationRanges(input)
  const fit = fitCalibration({ main, reference, ranges })
  return { rho: fit.rho, delta: fit.delta, gains: fit.gains, fit }
}

export function calibrate(input = {}) {
  const { audio: main } = decodeMain(input)
  const { audio: reference } = decodeReference(input)
  const ranges = calibrationRanges(input)
  const result = fitCalibration({ main, reference, ranges })
  return { ok: true, passed: true, ...result }
}

// 不抛异常的版本：拒绝时返回 { accepted:false, ok:false, reason, error, details }。
export function evaluateCalibration(input = {}) {
  try {
    return calibrate(input)
  } catch (error) {
    if (error instanceof CalibrationRejected) {
      return { accepted: false, ok: false, passed: false, code: error.code,
        reason: error.details?.reason ?? 'rejected', error: error.message, details: error.details }
    }
    throw error
  }
}

export function alignMachine(input = {}) {
  const { audio: main } = decodeMain(input)
  const { audio: reference } = decodeReference(input)
  const cal = resolveCalibration(input, main, reference)
  const aligned = renderAlignedReference({ main, reference, ...cal })
  const coverage = coverageInterval(cal, main.frames, reference.frames, main.rate, 0)
  return {
    wav: encode(aligned).toString('base64'),
    rate: main.rate, channels: main.tracks.length, frames: main.frames,
    rho: cal.rho, delta: cal.delta, gains: cal.gains,
    coverage: coverage ? [{ start: coverage.start, end: coverage.end }] : []
  }
}

export function cancelMachine(input = {}) {
  const { audio: main, wav: originalWav } = decodeMain(input)
  const { audio: reference } = decodeReference(input)
  const cal = resolveCalibration(input, main, reference)
  const repairs = repairRanges(input)
  for (const r of repairs) {
    if (![r.start, r.end].every(Number.isFinite) || r.start < 0 || r.end <= r.start || r.end > main.frames / main.rate) {
      throw new InputError('修复区需要位于录音时长内的有效开始与结束秒数。')
    }
  }
  let calZones = []
  if (input.keepCalibration !== false) {
    try { calZones = calibrationRanges(input) } catch { calZones = [] }
  }
  const stable = pick(input, ['stable', 'stableRange', 'measure', 'measureRange', 'stableSegment'])
  const result = renderCancel({
    main, reference, ...cal,
    repairs,
    calibrationRanges: calZones,
    fadeMs: Number(pick(input, ['fadeMs', 'fade', 'transitionMs']) ?? 12),
    measureRanges: stable ? [stable] : []
  })
  const coverage = coverageInterval(cal, main.frames, reference.frames, main.rate, 0)
  const coverageList = coverage ? [{ start: coverage.start, end: coverage.end }] : []
  const overlaps = repairs.map(r => {
    if (!coverage) return { start: r.start, end: r.end, overlap: null }
    const start = Math.max(r.start, coverage.start)
    const end = Math.min(r.end, coverage.end)
    return { start: r.start, end: r.end, overlap: end > start ? { start, end } : null }
  })
  // 调用方显式给出的 stable 区间是“稳段残声”的权威计量；
  // 未给出时退化为各修复区去掉平滑边后的核心区间。
  const stableMetrics = result.measures.length ? result.measures : result.stable
  const payload = {
    wav: encode(result).toString('base64'),
    rate: main.rate, channels: main.tracks.length, frames: main.frames,
    processedFrames: result.processedFrames,
    coverage: coverageList, overlaps,
    metrics: result.metrics,
    stable: stableMetrics,
    stableMetrics,
    cores: result.stable,
    measures: result.measures,
    calibration: cal.fit ? {
      rho: cal.fit.rho, delta: cal.fit.delta, gains: cal.fit.gains,
      calibration: cal.fit.calibration, events: cal.fit.events, segments: cal.fit.segments
    } : { rho: cal.rho, delta: cal.delta, gains: cal.gains }
  }
  // 没有任何采样被处理时原样返回上传 WAV 的 Base64，保证成品与原件同字节。
  if (result.processedFrames === 0 && originalWav) return { ...payload, wav: originalWav }
  return payload
}

export function coverageMachine(input = {}) {
  const { audio: main } = decodeMain(input)
  const { audio: reference } = decodeReference(input)
  const cal = resolveCalibration(input, main, reference)
  const display = coverageInterval(cal, main.frames, reference.frames, main.rate, 0)
  const playable = coverageInterval(cal, main.frames, reference.frames, main.rate, 8)
  return {
    coverage: display ? [{ start: display.start, end: display.end }] : [],
    processingCoverage: playable ? { start: playable.start, end: playable.end } : null,
    rho: cal.rho, delta: cal.delta, gains: cal.gains
  }
}

// 常见命名别名，便于不同调用方发现同一实现。
export {
  calibrate as calibrateMachine,
  cancelMachine as cancel,
  cancelMachine as repairMachine,
  alignMachine as align,
  coverageMachine as coverage
}
