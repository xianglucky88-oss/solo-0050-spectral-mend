// 声线（稳态电机谐波）辨认与包络一致性。
// “各声线在保护片外侧两端的包络与原位置同端相差至多该声线原段峰值的 5%”
// 由 evaluateEnvelope 量化。多条声线用联合最小二乘拟合，避免短窗内互相泄漏；
// 分析窗在相邻保护片处截断，防止把另一块撞击误计入本端包络。
import { transform } from '../spectrum/transform.mjs'

export const ENVELOPE_TOLERANCE = 0.05
const ANALYSIS_MS = 0.05 // 50 ms 局部包络窗
const MIN_WINDOW = 24
const TONAL_MIN = 48

function analysisWindow(rate) {
  return Math.max(MIN_WINDOW, Math.round(ANALYSIS_MS * rate))
}

// 联合拟合 y = Σ C_k cosθ_k n + Q_k sinθ_k n，返回每条声线的系数与幅度。
export function fitStems(channel, from, to, frequencies, rate) {
  const m = frequencies.length
  if (m === 0 || to - from < 4) return frequencies.map(freq => ({ freq, C: 0, Q: 0, amp: 0 }))
  const p = 2 * m
  const gram = Array.from({ length: p }, () => new Float64Array(p))
  const rhs = new Float64Array(p)
  const theta = frequencies.map(f => 2 * Math.PI * f / rate)
  for (let i = from; i < to; i++) {
    const n = i - from, y = channel[i] / 32768
    const basis = new Float64Array(p)
    for (let k = 0; k < m; k++) {
      basis[2 * k] = Math.cos(theta[k] * n)
      basis[2 * k + 1] = Math.sin(theta[k] * n)
    }
    for (let a = 0; a < p; a++) {
      rhs[a] += basis[a] * y
      for (let b = a; b < p; b++) gram[a][b] += basis[a] * basis[b]
    }
  }
  for (let a = 0; a < p; a++) for (let b = 0; b < a; b++) gram[a][b] = gram[b][a]
  const coef = solveLinear(gram, rhs)
  return frequencies.map((freq, k) => {
    const C = coef[2 * k] ?? 0, Q = coef[2 * k + 1] ?? 0
    return { freq, C, Q, amp: Math.hypot(C, Q) }
  })
}

// 带部分主元的高斯消元。
function solveLinear(matrix, vector) {
  const n = vector.length
  const a = matrix.map((row, i) => [...row, vector[i]])
  for (let col = 0; col < n; col++) {
    let pivot = col
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r
    ;[a[col], a[pivot]] = [a[pivot], a[col]]
    if (Math.abs(a[col][col]) < 1e-12) a[col][col] = a[col][col] < 0 ? -1e-12 : 1e-12
    for (let r = 0; r < n; r++) {
      if (r === col) continue
      const factor = a[r][col] / a[col][col]
      if (factor === 0) continue
      for (let c = col; c <= n; c++) a[r][c] -= factor * a[col][c]
    }
  }
  return Array.from({ length: n }, (_, i) => a[i][n] / a[i][i])
}

// 单声线拟合（保留给外部/兼容调用）。
export function fitTone(channel, from, to, frequency, rate) {
  return fitStems(channel, from, to, [frequency], rate)[0]
}

// 在一段较干净的电机窗内用 FFT 找主要稳态声线频率。
export function detectFrequencies(pcm, from, to, rate, { maxStems = 6 } = {}) {
  const length = to - from
  let n = 256
  while (n * 2 <= length && n <= 4096) n *= 2
  const start = from + Math.floor((length - n) / 2)
  const real = new Float64Array(n), imag = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1))
    let mono = 0
    for (let c = 0; c < pcm.length; c++) mono += pcm[c][start + i] / 32768
    real[i] = (mono / pcm.length) * w
  }
  transform(real, imag)
  const binHz = rate / n
  const ordered = []
  for (let k = 2; k < n / 2; k++) ordered.push({ k, hz: k * binHz, mag: Math.hypot(real[k], imag[k]) })
  ordered.sort((a, b) => b.mag - a.mag)
  const picked = []
  const minSep = Math.max(18, 2.2 * binHz)
  for (const peak of ordered) {
    if (picked.length >= maxStems) break
    if (peak.mag < ordered[0].mag * 0.06) break
    if (picked.some(f => Math.abs(f - peak.hz) < minSep)) continue
    const m = peak.k
    const here = Math.hypot(real[m], imag[m])
    const prev = Math.hypot(real[m - 1] ?? 0, imag[m - 1] ?? 0)
    const next = Math.hypot(real[m + 1] ?? 0, imag[m + 1] ?? 0)
    if (here < Math.max(prev, next)) continue
    const refined = refineFrequency(pcm[0], start, start + n, peak.hz, rate)
    picked.push(Math.round(refined * 100) / 100)
  }
  return picked.sort((a, b) => a - b)
}

function refineFrequency(channel, from, to, coarse, rate) {
  let best = coarse, bestAmp = -1
  const bin = rate / Math.max(1, to - from)
  for (let f = coarse - 2 * bin; f <= coarse + 2 * bin + 1e-9; f += Math.max(0.1, bin / 16)) {
    if (f <= 20 || f >= rate / 2 - 20) continue
    const amp = fitTone(channel, from, to, f, rate).amp
    if (amp > bestAmp) { bestAmp = amp; best = f }
  }
  return best
}

// 一组声线在某窗内的立体声合并幅度（功率合并，-1..1）。
export function stemLevelsAt(pcm, bounds, frequencies, rate) {
  return frequencies.map((freq, fi) => {
    let power = 0
    const channels = pcm.map(channel => {
      const fit = fitStems(channel, bounds.from, bounds.to, frequencies, rate)[fi]
      power += fit.amp * fit.amp
      return fit.amp
    })
    return { freq, channels, level: Math.sqrt(power) }
  })
}

function segmentPeaks(pcm, segment, frequencies, rate) {
  const [a, b] = segment
  const peaks = new Array(frequencies.length).fill(0)
  const win = analysisWindow(rate)
  const step = Math.max(win, Math.floor((b - a) / 10))
  for (let pos = a; pos + MIN_WINDOW < b; pos += step) {
    const bounds = { from: pos, to: Math.min(b, pos + win) }
    stemLevelsAt(pcm, bounds, frequencies, rate).forEach((l, i) => { peaks[i] = Math.max(peaks[i], l.level) })
  }
  stemLevelsAt(pcm, { from: Math.max(a, b - win), to: b }, frequencies, rate)
    .forEach((l, i) => { peaks[i] = Math.max(peaks[i], l.level) })
  return peaks
}

function rmsLevel(pcm, bounds) {
  let sum = 0, n = 0
  for (const ch of pcm) for (let i = bounds.from; i < bounds.to; i++) { sum += (ch[i] / 32768) ** 2; n++ }
  return Math.sqrt(sum / Math.max(1, n))
}

function segmentRmsPeak(pcm, segment, rate) {
  const [a, b] = segment
  const win = analysisWindow(rate)
  let peak = 0
  for (let pos = a; pos + MIN_WINDOW < b; pos += win) {
    peak = Math.max(peak, rmsLevel(pcm, { from: pos, to: Math.min(b, pos + win) }))
  }
  return peak
}

// 从边界 edge 向 side 最多取 want 帧，且不越过任何相邻保护片 [s,e]。
function availableLength(edge, side, total, blocks, want) {
  if (side === 'left') {
    let low = Math.max(0, edge - want)
    for (const [s, e] of blocks) if (e <= edge && e >= edge - want && e > low) low = e
    return Math.max(0, edge - low)
  }
  let high = Math.min(total, edge + want)
  for (const [s, e] of blocks) if (s >= edge && s <= edge + want && s < high) high = s
  return Math.max(0, high - edge)
}

// 评估每块保护片外两端：candidate 端相对 reference 源端的包络差 ≤ 5% 原段峰值。
// 分析窗在相邻保护片处截断；源/目标两端强制等长。candidate 传 pcm 自身为预查，
// 传渲染结果为接声后复核。
export function evaluateEnvelope({ reference, candidate = reference, rate, segment, items,
  frequencies = null, tolerance = ENVELOPE_TOLERANCE }) {
  const seg = Array.isArray(segment) ? segment : [segment?.start, segment?.end]
  const totalFrames = reference[0]?.length ?? 0
  const candidateFrames = candidate[0]?.length ?? totalFrames
  let freqs = frequencies
  if (!Array.isArray(freqs) || freqs.length === 0) {
    const [a, b] = seg
    freqs = detectFrequencies(reference, a + 256, b - 256, rate)
  }
  const win = analysisWindow(rate)
  const useTonal = freqs.length > 0
  const peaks = useTonal ? segmentPeaks(reference, seg, freqs, rate) : []
  const rmsPeak = segmentRmsPeak(reference, seg, rate)

  const checks = []
  let feasible = true
  items.forEach((item, position) => {
    const index = item.index ?? position
    const sourceBlocks = items.filter((_, j) => j !== position && Number.isInteger(items[j].sourceFrame))
      .map(o => [o.sourceFrame, o.sourceFrame + 32])
    const targetBlocks = items.filter((_, j) => j !== position && Number.isInteger(items[j].targetFrame))
      .map(o => [o.targetFrame, o.targetFrame + 32])
    for (const side of ['left', 'right']) {
      const sourceEdge = side === 'left' ? item.sourceFrame : item.sourceFrame + 32
      const targetEdge = side === 'left' ? item.targetFrame : item.targetFrame + 32
      const srcAvail = availableLength(sourceEdge, side, totalFrames, sourceBlocks, win)
      const tgtAvail = availableLength(targetEdge, side, candidateFrames, targetBlocks, win)
      const length = Math.max(1, Math.min(srcAvail, tgtAvail, win))
      const srcBounds = side === 'left' ? { from: sourceEdge - length, to: sourceEdge }
        : { from: sourceEdge, to: sourceEdge + length }
      const tgtBounds = side === 'left' ? { from: targetEdge - length, to: targetEdge }
        : { from: targetEdge, to: targetEdge + length }

      // 空间过短、无法稳定分声线时，退化为等长局部能量包络比较；
      // 短于 12 帧（典型为下限 2 帧接声间隙）已无“声线包络”可估，
      // 交由几何与接声淡变保证，记为不否决（indeterminate）。
      if (!useTonal || length < TONAL_MIN) {
        if (length < 12) {
          checks.push({ index, side, kind: 'indeterminate', frames: length, ok: true, ratio: 0 })
          continue
        }
        const src = rmsLevel(reference, srcBounds), out = rmsLevel(candidate, tgtBounds)
        const limit = tolerance * rmsPeak
        const delta = Math.abs(out - src)
        const ok = delta <= limit + 1e-6
        feasible &&= ok
        checks.push({ index, side, kind: 'rms', frames: length, source: src, candidate: out,
          peak: rmsPeak, delta, limit, ratio: rmsPeak ? delta / rmsPeak : 0, ok })
        continue
      }
      const srcLevels = stemLevelsAt(reference, srcBounds, freqs, rate)
      const outLevels = stemLevelsAt(candidate, tgtBounds, freqs, rate)
      freqs.forEach((freq, i) => {
        const delta = Math.abs(outLevels[i].level - srcLevels[i].level)
        const limit = tolerance * peaks[i]
        const ok = delta <= limit + 1e-6
        feasible &&= ok
        checks.push({ index, side, freq, frames: length, source: srcLevels[i].level, candidate: outLevels[i].level,
          peak: peaks[i], delta, limit, ratio: peaks[i] ? delta / peaks[i] : 0, ok })
      })
    }
  })
  const worst = checks.reduce((m, c) => Math.max(m, c.ratio), 0)
  return { feasible, tolerance, frequencies: freqs, worstRatio: worst, checks }
}
