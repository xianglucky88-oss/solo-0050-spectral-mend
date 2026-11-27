import { peakLags } from './xcorr.mjs'
import { resampleBandlimited } from './resample.mjs'
import { rms } from './levels.mjs'

const COARSE_RATE = 8000

// 短时 RMS 包络（2ms 跳、8ms 窗），统一到约 500Hz 的时间网格。
function envelope(track, rate) {
  const win = Math.max(4, Math.round(0.008 * rate))
  const hop = Math.max(1, Math.round(0.002 * rate))
  const count = Math.max(0, Math.floor((track.length - win) / hop) + 1)
  const env = new Float64Array(count)
  for (let e = 0; e < count; e++) {
    const p = e * hop
    let sum = 0
    for (let i = p; i < p + win; i++) sum += track[i] * track[i]
    env[e] = Math.sqrt(sum / win)
  }
  return { env, envelopeRate: rate / hop }
}

// 包络双锚点估计物理速率比 k 与偏移。极廉价且对恒定速率差涂抹不敏感。
export function envelopeAnchors({ main, refMono, framed, Fx, Fr }) {
  const refPack = envelope(refMono, Fr)
  const E = refPack.envelopeRate
  const refE = refPack.env
  const offsets = []
  const centers = []
  for (let s = 0; s < 2; s++) {
    const [a, b] = framed[s]
    let channel = 0, bestLevel = -1
    main.tracks.forEach((t, c) => { const v = rms(t, a, b); if (v > bestLevel) { bestLevel = v; channel = c } })
    const fullEnv = envelope(main.tracks[channel], Fx).env
    const aE = Math.round(a / Fx * E), bE = Math.round(b / Fx * E)
    const seg = fullEnv.slice(aE, Math.min(fullEnv.length, bE))
    if (seg.length < 8) return null
    const peaks = peakLags(seg, refE, { limit: 4, exclusion: Math.round(0.03 * E), minNcc: 0.3, minOverlap: 0.8 })
    if (!peaks.length) return null
    // peakLags 契约 seg[i] ~ refE[i + p]；换算为全局偏移 o = p - aE。
    offsets.push(peaks[0].fineLag - aE)
    centers.push((aE + bE) / 2)
  }
  if (offsets.length !== 2) return null
  const k = 1 + (offsets[1] - offsets[0]) / (centers[1] - centers[0])
  if (!(k > 0.5 && k < 2)) return null
  return { k, offset1: offsets[0], center1: centers[0] }
}


function warpLinear(source, slope) {
  const length = Math.max(1, Math.floor((source.length - 1) / slope) + 1)
  const out = new Float64Array(length)
  for (let u = 0; u < length; u++) {
    const pos = slope * u
    const i = Math.floor(pos), f = pos - i
    if (i >= source.length - 1) { out[u] = source[source.length - 1]; continue }
    out[u] = source[i] * (1 - f) + source[i + 1] * f
  }
  return out
}

function bestSegmentPeak(mainC, rangesC, s, qk, blockLength) {
  const [a, b] = rangesC[s]
  // 取段中央的短块，降低 k 网格误差造成的跨块涂抹。
  const center = (a + b) >> 1
  const half = Math.floor(blockLength / 2)
  const ba = Math.max(a, center - half), bb = Math.min(b, center + half)
  const length = bb - ba
  let channel = 0, bestLevel = -1
  mainC.forEach((track, c) => {
    const level = rms(track, ba, bb)
    if (level > bestLevel) { bestLevel = level; channel = c }
  })
  const x = mainC[channel].slice(ba, bb)
  const peaks = peakLags(x, qk, { limit: 2, exclusion: 16, minNcc: 0.22 })
  if (!peaks.length) return null
  const p = peaks[0]
  // 短块起点 ba：全局粗坐标 lag oC = k * (fineLag - ba)
  return { ncc: Math.abs(p.ncc), coarseOffset: p.fineLag - ba, ba }
}

// 多分辨率 k 搜索，返回若干 { rho, delta, score } 初始化。
export function coarseSearch({ main, refMono, framed, Fx, Fr }) {
  const C = Math.min(COARSE_RATE, Fx)
  const mainC = main.tracks.map(t => resampleBandlimited(t, Fx, C))
  const refC = resampleBandlimited(refMono, Fr, C)
  const rangesC = framed.map(([a, b]) => [Math.round(a * C / Fx), Math.round(b * C / Fx)])
  const blockLength = Math.min(1024, rangesC[0][1] - rangesC[0][0], rangesC[1][1] - rangesC[1][0])

  function scoreK(k, full = false) {
    const qk = warpLinear(refC, k)
    let a = rangesC[0][0], b = rangesC[0][1]
    const p1 = full ? fullPeak(0, qk) : bestSegmentPeak(mainC, rangesC, 0, qk, blockLength)
    const p2 = full ? fullPeak(1, qk) : bestSegmentPeak(mainC, rangesC, 1, qk, blockLength)
    if (!p1 || !p2) return null
    const offsetC = (k * p1.coarseOffset + k * p2.coarseOffset) / 2
    const rho = k * Fr / Fx
    const delta = Fr / C * offsetC
    return { rho, delta, score: Math.min(p1.ncc, p2.ncc), sum: p1.ncc + p2.ncc }
  }

  function fullPeak(s, qk) {
    const [a, b] = rangesC[s]
    const length = b - a
    let channel = 0, bestLevel = -1
    mainC.forEach((track, c) => { const level = rms(track, a, b); if (level > bestLevel) { bestLevel = level; channel = c } })
    const x = mainC[channel].slice(a, b)
    const peaks = peakLags(x, qk, { limit: 3, exclusion: Math.max(8, Math.round(0.002 * C)), minNcc: 0.2 })
    if (!peaks.length) return null
    return { ncc: Math.abs(peaks[0].ncc), coarseOffset: peaks[0].fineLag - a }
  }

  const found = []
  const sweep = (lo, hi, step) => {
    for (let k = lo; k <= hi + 1e-9; k += step) {
      const result = scoreK(Number(k.toFixed(6)))
      if (result && result.score > 0.3) found.push({ k, ...result })
    }
  }
  sweep(0.8, 1.25, 0.01)
  found.sort((a, b) => b.score - a.score)
  const seeds = found.slice(0, 4)
  const refined = []
  for (const seed of seeds) {
    for (let k = seed.k - 0.012; k <= seed.k + 0.012 + 1e-9; k += 0.002) {
      const result = scoreK(Number(k.toFixed(6)))
      if (result) refined.push({ k, ...result })
    }
  }
  refined.sort((a, b) => b.score - a.score)
  const bestK = refined[0]?.k ?? found[0]?.k
  if (bestK !== undefined) {
    for (let k = bestK - 0.0022; k <= bestK + 0.0022 + 1e-9; k += 0.0005) {
      const result = scoreK(Number(k.toFixed(6)), true)
      if (result) refined.push({ k, ...result })
    }
  }
  // 用最佳 k 的全段相关给出最终高精度粗初始化。
  const top = refined.sort((a, b) => b.score - a.score).slice(0, 6)
  const inits = []
  for (const item of top) {
    const qk = warpLinear(refC, item.k)
    const p1 = fullPeak(0, qk), p2 = fullPeak(1, qk)
    if (!p1 || !p2) continue
    const offsetC = (item.k * p1.coarseOffset + item.k * p2.coarseOffset) / 2
    inits.push({ rho: item.k * Fr / Fx, delta: Fr / C * offsetC, score: Math.min(p1.ncc, p2.ncc) })
  }
  // 去重。
  const distinct = []
  for (const init of inits.sort((a, b) => b.score - a.score)) {
    if (distinct.every(d => Math.abs(d.delta - init.delta) > 0.001 * Fr || Math.abs(d.rho - init.rho) / init.rho > 1e-4)) {
      distinct.push(init)
    }
  }
  return distinct.slice(0, 4)
}
