// 落锁对轨工作台编排：WAV(base64) -> 整数 PCM16 -> 双路辨认/几何/搬迁 -> 等长 PCM16 WAV。
// 所有领域性失败（找不到唯一撞击、几何冲突、接声无解）都返回 changed:false 并
// 原样回传输入 wav，由前端提示重圈或调整目标；只有请求本身不合法才抛 InputError。
import { decodePcm16, encodePcm16Wav, pcm16ToTracks } from '../audio/pcm16.mjs'
import { metrics } from '../repair/metrics.mjs'
import { parseLockRequest } from './params.mjs'
import { detectImpact } from './detect.mjs'
import { relocate, previewFeasibility } from './relocate.mjs'
import { validateGeometry, BLOCK_FRAMES, EDGE_FRAMES, JOIN_FRAMES } from './geometry.mjs'
import { lockDemo } from './demo.mjs'

function stereoOrFail(audio, input) {
  if (audio.channels !== 2) {
    return { ok: false, changed: false, code: 'need-stereo',
      reason: '落锁撞击需要左右两路同时确认，请使用双声道录音。', wav: input.wav }
  }
  return null
}

function detectAll(pcm, locks) {
  return locks.map(lock => {
    if (Number.isInteger(lock.sourceFrame)) {
      return { index: lock.index, unique: true, confirmed: true, frame: lock.sourceFrame,
        sourceFrame: lock.sourceFrame, zeroBasedSourceFrame: lock.sourceFrame, explicit: true, candidates: [] }
    }
    if (!lock.search || !Number.isInteger(lock.search.start) || !Number.isInteger(lock.search.end)) {
      return { index: lock.index, unique: false, confirmed: false, frame: null,
        code: 'range-invalid', reason: '请先填写有效的原声搜索范围。', candidates: [] }
    }
    const result = detectImpact(pcm, lock.search.start, lock.search.end)
    return { index: lock.index, ...result, sourceFrame: result.frame, zeroBasedSourceFrame: result.frame }
  })
}

export { lockDemo }

export function lockInspect(input = {}) {
  const audio = decodePcm16(input.wav)
  const stereoFail = stereoOrFail(audio, input)
  if (stereoFail) return { ...stereoFail, rate: audio.rate, frames: audio.frames, channels: audio.channels }

  const parsed = parseLockRequest(input, audio)
  const detections = detectAll(audio.pcm, parsed.locks)
  const items = parsed.locks.map((lock, i) => ({
    index: i,
    sourceFrame: detections[i].frame ?? null,
    targetFrame: lock.targetFrame
  }))
  const haveTargets = items.every(it => Number.isInteger(it.targetFrame))
  const geometry = validateGeometry({ segment: parsed.segment, items,
    requireSource: true, requireTarget: haveTargets })

  let envelope = null
  if (geometry.ok && haveTargets) {
    envelope = previewFeasibility({ pcm: audio.pcm, rate: audio.rate, segment: parsed.segment,
      items, frequencies: parsed.frequencies, tolerance: parsed.tolerance }).envelope
  }

  const unique = detections.every(d => d.unique)
  return {
    ok: unique,
    changed: false,
    rate: audio.rate,
    frames: audio.frames,
    channels: audio.channels,
    zeroBased: true,
    blockFrames: BLOCK_FRAMES,
    edgeFrames: EDGE_FRAMES,
    joinFrames: JOIN_FRAMES,
    segment: { start: parsed.segment[0], end: parsed.segment[1] },
    detections,
    locks: parsed.locks.map((lock, i) => ({ ...lock, detection: detections[i],
      sourceFrame: detections[i].frame, zeroBasedSourceFrame: detections[i].frame })),
    sourceFrames: detections.map(d => d.frame),
    geometry,
    envelope: envelope ? { feasible: envelope.feasible, worstRatio: envelope.worstRatio,
      tolerance: envelope.tolerance, frequencies: envelope.frequencies } : null,
    needReselect: !unique,
    reason: unique ? (geometry.ok ? null : geometry.violations[0]?.message)
      : detections.find(d => !d.unique)?.reason
  }
}

export function lockMove(input = {}) {
  const originalWav = input.wav
  const audio = decodePcm16(originalWav)
  const base = { rate: audio.rate, frames: audio.frames, channels: audio.channels, zeroBased: true,
    blockFrames: BLOCK_FRAMES }
  const stereoFail = stereoOrFail(audio, input)
  if (stereoFail) return { ...base, ...stereoFail }

  const parsed = parseLockRequest(input, audio)
  const detections = detectAll(audio.pcm, parsed.locks)

  // 找不到唯一撞击：保留原声，提示重圈。
  const bad = detections.find(d => !d.unique)
  if (bad) {
    return { ...base, ok: false, changed: false, code: bad.code ?? 'not-unique',
      reason: bad.reason ?? '找不到唯一撞击，请重新圈选原声搜索范围。',
      needReselect: true, reselect: true, wav: originalWav, wavBase64: originalWav,
      detections, sourceFrames: detections.map(d => d.frame) }
  }

  const items = parsed.locks.map((lock, i) => ({
    index: i, sourceFrame: detections[i].frame, targetFrame: lock.targetFrame
  }))

  const result = relocate({ pcm: audio.pcm, rate: audio.rate, segment: parsed.segment,
    items, frequencies: parsed.frequencies, tolerance: parsed.tolerance })

  if (!result.ok) {
    const adjustTarget = result.code === 'no-join-solution' || result.code === 'geometry'
    return { ...base, ok: false, changed: false, code: result.code, reason: result.reason,
      adjustTarget, needAdjustTarget: result.code === 'no-join-solution',
      violations: result.violations ?? null, envelope: summarizeEnvelope(result.envelope),
      wav: originalWav, wavBase64: originalWav, detections,
      sourceFrames: result.sourceFrames ?? items.map(i => i.sourceFrame),
      targetFrames: items.map(i => i.targetFrame) }
  }

  const wavBuffer = encodePcm16Wav({ pcm: result.pcm, rate: audio.rate })
  const wav = wavBuffer.toString('base64')
  const afterTracks = pcm16ToTracks(result.pcm)
  const measure = metrics({ tracks: pcm16ToTracks(audio.pcm) }, { tracks: afterTracks })

  const response = {
    ...base,
    ok: true,
    changed: true,
    code: 'moved',
    wav,
    wavBase64: wav,
    sameLength: true,
    channels: 2,
    sourceFrames: result.sourceFrames,
    targetFrames: result.targetFrames,
    locks: items,
    metrics: measure,
    envelope: summarizeEnvelope(result.envelope),
    gaps: result.plan?.gaps?.map(({ g0, g1, left, right }) => ({ start: g0, end: g1, frames: g1 - g0, left, right })),
    frequencies: result.plan?.frequencies ?? parsed.frequencies,
    reason: null
  }
  if (input.includePcm) response.pcm = result.pcm
  return response
}

function summarizeEnvelope(envelope) {
  if (!envelope) return null
  return { feasible: envelope.feasible, worstRatio: envelope.worstRatio,
    tolerance: envelope.tolerance, frequencies: envelope.frequencies,
    failures: envelope.checks?.filter(c => !c.ok) ?? [] }
}
