import { makeKernel, tableAt } from './interpolate.mjs'
import { rms } from './levels.mjs'

const kernel = makeKernel(8, 8.6)

function mergeIntervals(intervals) {
  const sorted = intervals.map(([a, b]) => [Math.round(a), Math.round(b)])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((p, q) => p[0] - q[0])
  const merged = []
  for (const [a, b] of sorted) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) last[1] = Math.max(last[1], b)
    else merged.push([a, b])
  }
  return merged
}

// 修复区减去校准段（校准段必须逐码原样）。
function subtractRanges(parts, cuts) {
  let result = parts
  for (const [ca, cb] of cuts) {
    const next = []
    for (const [a, b] of result) {
      if (cb <= a || ca >= b) { next.push([a, b]); continue }
      if (ca > a) next.push([a, Math.min(ca, b)])
      if (cb < b) next.push([Math.max(cb, a), b])
    }
    result = next
  }
  return result
}

function hann(t) {
  const x = Math.max(0, Math.min(1, t))
  return 0.5 - 0.5 * Math.cos(Math.PI * x)
}

// 生成每帧消声权重。只在“修复区 ∩ 参考覆盖”内非零，
// 并在各处理分量两端做 Hann 平滑；校准段权重恒为 0。
export function weightEnvelope({ frames, rate, rho, delta, referenceFrames, repairs, calibrationRanges = [], fadeMs = 12 }) {
  const weight = new Float64Array(frames)
  const fade = Math.max(1, Math.round((fadeMs / 1000) * rate))
  // 插值核完整支撑所要求的参考采样余量。
  const covLo = Math.ceil((kernel.lobes - delta) / rho)
  const covHi = Math.floor((referenceFrames - 1 - kernel.lobes - delta) / rho)
  const repairIntervals = mergeIntervals(repairs.map(r => [r.start * rate, r.end * rate]))
    .map(([a, b]) => [Math.max(0, a), Math.min(frames, b)])
    .filter(([a, b]) => b > a)
  const cuts = calibrationRanges.map(r => [Math.round(r.start * rate), Math.round(r.end * rate)])
  for (let [a, b] of repairIntervals) {
    a = Math.max(a, covLo)
    b = Math.min(b, covHi + 1)
    if (b <= a) continue
    let parts = subtractRanges([[a, b]], cuts)
    for (const [p, q] of parts) {
      const length = q - p
      const f = Math.min(fade, Math.floor(length / 2))
      for (let n = p; n < q; n++) {
        let w = 1
        if (n - p < f) w = hann((n - p + 1) / (f + 1))
        else if (q - 1 - n < f) w = hann((q - n) / (f + 1))
        weight[n] = w
      }
    }
  }
  return { weight, coverageFrames: [Math.max(0, covLo), Math.min(frames, covHi + 1)] }
}

function toMono(reference) {
  if (reference.tracks.length === 1) return reference.tracks[0]
  const mono = new Float64Array(reference.frames)
  for (let c = 0; c < reference.tracks.length; c++) {
    for (let i = 0; i < reference.frames; i++) mono[i] += reference.tracks[c][i] / reference.tracks.length
  }
  return mono
}

// 波形相减消声：out_c[n] = in_c[n] - weight[n] * gain_c * ref(rho*n+delta)。
// weight 为 0 的采样直接保留原 Float64 值，编码后与原 PCM16 逐码一致。
export function renderCancel({ main, reference, rho, delta, gains, repairs, calibrationRanges, fadeMs, measureRanges = [] }) {
  const refMono = toMono(reference)
  const { weight, coverageFrames } = weightEnvelope({
    frames: main.frames, rate: main.rate, rho, delta,
    referenceFrames: reference.frames, repairs, calibrationRanges, fadeMs
  })
  const tracks = main.tracks.map(track => Float64Array.from(track))
  let processedFrames = 0
  let weightSum = 0
  for (let n = 0; n < main.frames; n++) {
    const w = weight[n]
    if (w <= 0) continue
    processedFrames++
    weightSum += w
    const z = tableAt(kernel, refMono, rho * n + delta)
    for (let c = 0; c < tracks.length; c++) {
      tracks[c][n] = main.tracks[c][n] - w * gains[c] * z
    }
  }

  const quant = tracks.map(track => {
    let saturation = 0, peak = 0
    for (const v of track) {
      peak = Math.max(peak, Math.abs(v))
      const q = Math.round(v * 32768)
      if (q < -32768 || q > 32767) saturation++
    }
    return { saturation, outputPeak: peak }
  })

  // 每个修复区“稳段核心”（去掉平滑边）的修前/修后 RMS。
  const stable = repairs.map(range => {
    const a = Math.round(range.start * main.rate), b = Math.round(range.end * main.rate)
    const f = Math.round((fadeMs ?? 12) / 1000 * main.rate)
    const ca = Math.max(0, a + f), cb = Math.min(main.frames, b - f)
    return measureBlock(main, tracks, ca, cb, range)
  }).filter(Boolean)

  const extraMeasures = measureRanges.map(range => {
    const a = Math.round(range.start * main.rate), b = Math.round(range.end * main.rate)
    return measureBlock(main, tracks, a, b, range)
  }).filter(Boolean)

  const metrics = main.tracks.map((_, c) => {
    let deltaSq = 0, originalPeak = 0
    for (let n = 0; n < main.frames; n++) {
      originalPeak = Math.max(originalPeak, Math.abs(main.tracks[c][n]))
      deltaSq += (main.tracks[c][n] - tracks[c][n]) ** 2
    }
    return {
      originalPeak,
      outputPeak: quant[c].outputPeak,
      saturation: quant[c].saturation,
      differenceRms: Math.sqrt(deltaSq / main.frames)
    }
  })

  return {
    tracks, rate: main.rate, frames: main.frames, channels: tracks.length,
    weight, processedFrames, weightAverage: processedFrames ? weightSum / processedFrames : 0,
    coverageFrames, metrics, stable, measures: extraMeasures
  }
}

function measureBlock(main, tracks, a, b, range) {
  if (!(b > a + 4)) return null
  const channels = main.tracks.map((_, c) => {
    const before = rms(main.tracks[c], a, b)
    const after = rms(tracks[c], a, b)
    return {
      rmsBefore: before, rmsAfter: after,
      ratio: before > 1e-12 ? after / before : 0,
      reductionDb: after > 1e-12 ? 20 * Math.log10(Math.max(after, 1e-12) / Math.max(before, 1e-12)) : -Infinity,
      passQuarter: after <= 0.25 * before
    }
  })
  return { start: a / main.rate, end: b / main.rate, channels }
}

// 生成与主录音同采样率/声道/时长的“已校准参考”，供生成前同位置对听。
export function renderAlignedReference({ main, reference, rho, delta, gains }) {
  const refMono = toMono(reference)
  const tracks = main.tracks.map(() => new Float64Array(main.frames))
  for (let n = 0; n < main.frames; n++) {
    const pos = rho * n + delta
    if (pos < 0 || pos > reference.frames - 1) continue
    const z = tableAt(kernel, refMono, pos)
    for (let c = 0; c < tracks.length; c++) tracks[c][n] = (gains?.[c] ?? 1) * z
  }
  return { tracks, rate: main.rate, frames: main.frames, channels: tracks.length }
}
