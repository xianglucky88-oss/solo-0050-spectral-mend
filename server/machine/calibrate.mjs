import { InputError } from '../http/error.mjs'
import { peakLags } from './xcorr.mjs'
import { makeKernel, tablePair, tableAt } from './interpolate.mjs'
import { rms, rmseLimit, CODE } from './levels.mjs'
import { calibrationFromLags, lagsFromRhoDelta, describeCalibration, coverageInterval } from './geometry.mjs'
import { eventAlignment } from './events.mjs'
import { coarseSearch, envelopeAnchors } from './coarse.mjs'

export class CalibrationRejected extends InputError {
  constructor(message, details = {}) {
    super(message, 400)
    this.code = 'calibration_rejected'
    this.details = details
  }
}

const kernel = makeKernel(8, 8.6)
const SILENCE_RMS = 4 / 32768

function toMono(reference) {
  if (reference.tracks.length === 1) return reference.tracks[0]
  const mono = new Float64Array(reference.frames)
  for (let c = 0; c < reference.tracks.length; c++) {
    for (let i = 0; i < reference.frames; i++) mono[i] += reference.tracks[c][i] / reference.tracks.length
  }
  return mono
}

function rangeFrames(range, rate, frames) {
  if (!range || ![range.start, range.end].every(Number.isFinite)) {
    throw new InputError('校准段需要有效的开始与结束秒数。')
  }
  const a = Math.round(range.start * rate), b = Math.round(range.end * rate)
  if (!(b > a) || a < 0 || b > frames) {
    throw new InputError('校准段需位于录音时长内，且结束晚于开始。')
  }
  if (b - a < Math.round(0.03 * rate)) throw new InputError('校准段过短，至少需要约 30 毫秒。')
  return [a, b]
}

// 构造指定斜率 rho 的参考重采样序列 q[u] = ref[rho u]。
function nominalWarpAtRho(reference, rho) {
  const length = Math.ceil(reference.length / rho) + 2
  const q = new Float64Array(length)
  for (let u = 0; u < length; u++) q[u] = tableAt(kernel, reference, rho * u)
  return q
}

// 联合拟合主入口。输入为已解码音频。
export function fitCalibration({ main, reference, ranges, first, second, candidatePairs = 12, verbose = false }) {
  const Fx = main.rate, Fr = reference.rate
  const refMono = toMono(reference)
  const ratio = Fr / Fx
  const channels = main.tracks

  // 两个校准段按时间排序为前、后。
  const rangeList = ranges ?? [first, second]
  let framed = rangeList.map(r => rangeFrames(r, Fx, main.frames)).sort((p, q) => p[0] - q[0])
  if (framed.length !== 2) throw new InputError('需要前后两段纯机器声校准区。')
  const [[a1, b1], [a2, b2]] = framed
  if (a2 < b1 - Math.round(0.02 * Fx)) throw new InputError('前后校准段不应重叠，请重新圈选。')
  const n1 = (a1 + b1) / 2, n2 = (a2 + b2) / 2
  if (Math.abs(n2 - n1) < 0.05 * Fx) throw new InputError('两段校准区中心距离过近，无法辨识恒定速率差。')

  // 静音检查：任一段所有声道都接近静音即拒绝。
  const segmentLevels = framed.map(([a, b]) => channels.map(t => rms(t, a, b)))
  framed.forEach(([a, b], s) => {
    const loudest = Math.max(...segmentLevels[s])
    if (loudest < SILENCE_RMS) {
      throw new CalibrationRejected('校准段近乎静音，找不到可校准的机器声。请更换包含清晰机器响动的录音或校准区后重新确认。',
        { reason: 'silence', segment: s === 0 ? 'first' : 'second', levels: segmentLevels[s] })
    }
  })
  if (rms(refMono) < SILENCE_RMS) {
    throw new CalibrationRejected('机器参考录音近乎静音，无法校准。请更换参考录音后重新确认。', { reason: 'silence', segment: 'reference' })
  }

  // 组装全部校准采样与仿射系数。
  const total = (b1 - a1) + (b2 - a2)
  const N = new Float64Array(total), C1 = new Float64Array(total), C2 = new Float64Array(total)
  const SEG = new Uint8Array(total)
  let count = 0
  framed.forEach(([a, b], s) => {
    for (let n = a; n < b; n++) {
      const w = (n - n1) / (n2 - n1)
      N[count] = n
      C1[count] = ratio * (1 - w)
      C2[count] = ratio * w
      SEG[count] = s
      count++
    }
  })

  function evaluate(lag1, lag2, build = false) {
    const zArr = build ? new Float64Array(count) : null
    const d1Arr = build ? new Float64Array(count) : null
    const d2Arr = build ? new Float64Array(count) : null
    const gains = new Array(channels.length).fill(0)
    let totalSSE = 0
    let support = true
    const stats = channels.map(() => ({ xx: 0, xz: 0, zz: 0 }))
    for (let i = 0; i < count; i++) {
      const m = ratio * N[i] + C1[i] * lag1 + C2[i] * lag2
      if (m < kernel.lobes || m > refMono.length - 1 - kernel.lobes) support = false
      const { y, dy } = tablePair(kernel, refMono, m)
      if (build) { zArr[i] = y; d1Arr[i] = dy * C1[i]; d2Arr[i] = dy * C2[i] }
      for (let c = 0; c < channels.length; c++) {
        const x = channels[c][N[i]]
        stats[c].xx += x * x
        stats[c].xz += x * y
        stats[c].zz += y * y
      }
    }
    for (let c = 0; c < channels.length; c++) {
      gains[c] = stats[c].zz > 1e-18 ? stats[c].xz / stats[c].zz : 0
      totalSSE += stats[c].xx - stats[c].xz * stats[c].xz / Math.max(stats[c].zz, 1e-30)
      totalSSE = Math.max(0, totalSSE)
    }
    // 第二段遍历：RMSE 分组 + GN 法方程。
    const sse = channels.map(() => [0, 0])
    const H = [0, 0, 0], rhs = [0, 0]
    for (let i = 0; i < count; i++) {
      let z, dz1, dz2
      if (build) { z = zArr[i]; dz1 = d1Arr[i]; dz2 = d2Arr[i] }
      else {
        const m = ratio * N[i] + C1[i] * lag1 + C2[i] * lag2
        const pair = tablePair(kernel, refMono, m)
        z = pair.y; dz1 = pair.dy * C1[i]; dz2 = pair.dy * C2[i]
        if (m < kernel.lobes || m > refMono.length - 1 - kernel.lobes) support = false
      }
      for (let c = 0; c < channels.length; c++) {
        const g = gains[c]
        const e = channels[c][N[i]] - g * z
        sse[c][SEG[i]] += e * e
        H[0] += g * g * dz1 * dz1
        H[1] += g * g * dz1 * dz2
        H[2] += g * g * dz2 * dz2
        rhs[0] += g * dz1 * e
        rhs[1] += g * dz2 * e
      }
    }
    const lengths = [b1 - a1, b2 - a2]
    const rmse = sse.map(pair => pair.map((v, s) => Math.sqrt(v / lengths[s])))
    return { totalSSE, gains, rmse, H, rhs, support, zArr, d1Arr, d2Arr }
  }

  // 高斯-牛顿 + Levenberg 阻尼。
  function refine(init1, init2) {
    let l1 = init1, l2 = init2
    let current = evaluate(l1, l2, true)
    let lambda = 1e-3
    for (let iter = 0; iter < 40; iter++) {
      const { H, rhs } = current
      let accepted = false
      for (let attempt = 0; attempt < 12 && !accepted; attempt++) {
        const a = H[0] + lambda * (H[0] || 1), b = H[1], d = H[2] + lambda * (H[2] || 1)
        const det = a * d - b * b
        if (Math.abs(det) < 1e-30) { lambda *= 4; continue }
        const dl1 = (rhs[0] * d - b * rhs[1]) / det
        const dl2 = (a * rhs[1] - b * rhs[0]) / det
        if (![dl1, dl2].every(Number.isFinite)) { lambda *= 4; continue }
        const next = evaluate(l1 + dl1, l2 + dl2, true)
        if (next.totalSSE < current.totalSSE + 1e-12) {
          l1 += dl1; l2 += dl2; current = next
          lambda = Math.max(1e-6, lambda / 3)
          accepted = true
          if (Math.max(Math.abs(dl1), Math.abs(dl2)) < 1e-6) return { l1, l2, result: current }
        } else lambda *= 4
      }
      if (!accepted) break
    }
    // 坐标收缩兜底，压到亚毫码级。
    let step = 1
    for (let round = 0; round < 9; round++) {
      let improved = false
      for (const dir of [[step, 0], [-step, 0], [0, step], [0, -step]]) {
        const cand = evaluate(l1 + dir[0], l2 + dir[1])
        if (cand.totalSSE < current.totalSSE - 1e-14) {
          l1 += dir[0]; l2 += dir[1]; current = evaluate(l1, l2, true); improved = true
        }
      }
      if (!improved) step *= 0.5
      if (step < 1e-5) break
    }
    return { l1, l2, result: current }
  }

  // 粗对齐候选：对若干速率假设（名义 1.0 与包络双锚点 kEnv），
  // 取每段中央短块做 FFT 互相关，多峰配对以保留周期歧义候选。
  const inits = []
  const shortest = Math.min(...framed.map(([a, b]) => b - a))
  const blockSamples = Math.max(Math.round(0.08 * Fx), Math.min(shortest, Math.round(0.3 * Fx)))

  function centerPeaks([a, b], rhoWarp) {
    const warp = nominalWarpAtRho(refMono, rhoWarp)
    const bc = (a + b) / 2
    const blk = Math.min(b - a, blockSamples)
    const ba = Math.round(bc - blk / 2)
    let bestChannel = 0, bestRms = -1
    channels.forEach((t, c) => { const v = rms(t, ba, ba + blk); if (v > bestRms) { bestRms = v; bestChannel = c } })
    const x = channels[bestChannel].slice(ba, ba + blk)
    const peaks = peakLags(x, warp, {
      limit: 8, exclusion: Math.max(12, Math.round(0.002 * Fx)), minNcc: 0.2
    })
    // 短块局部下标 i 匹配 warp[i+p]；换算为名义几何下的段中心滞后 l_s。
    return peaks.map(p => ({
      l: rhoWarp * (bc - ba + p.fineLag) / ratio - bc,
      ncc: Math.abs(p.ncc)
    }))
  }

  const slopeHints = [{ k: 1, rhoWarp: ratio, tol: 0.02 }]
  try {
    const anchor = envelopeAnchors({ main, refMono, framed, Fx, Fr })
    if (anchor && Number.isFinite(anchor.k) && anchor.k > 0.5 && anchor.k < 2) {
      slopeHints.push({ k: anchor.k, rhoWarp: anchor.k * ratio, tol: 0.03 })
    }
  } catch { /* 包络不可用时仅用名义速率 */ }

  for (const hint of slopeHints) {
    const p1 = centerPeaks(framed[0], hint.rhoWarp)
    const p2 = centerPeaks(framed[1], hint.rhoWarp)
    for (const a of p1) for (const b of p2) {
      const kImplied = 1 + (b.l - a.l) / (n2 - n1)
      // 与本速率假设一致才成对：排除周期信号跨周期错配，同时保留同周期平移的多个歧义解。
      if (!(kImplied > 0.5 && kImplied < 2) || Math.abs(kImplied - hint.k) > hint.tol) continue
      inits.push({ l1: a.l, l2: b.l, score: a.ncc + b.ncc, origin: hint.k === 1 ? 'nominal' : 'envelope' })
    }
  }

  // 候选去重（初值相差小于 2 个主采样视为同一个）。
  const tried = []
  for (const init of inits.sort((a, b) => b.score - a.score)) {
    if (tried.every(t => Math.max(Math.abs(t.l1 - init.l1), Math.abs(t.l2 - init.l2)) > 2)) tried.push(init)
    if (tried.length >= candidatePairs) break
  }

  if (!tried.length) {
    // 名义/包络都没给出候选（常见于较大速率差）：直接用 k 网格救援。
    try {
      for (const c of coarseSearch({ main, refMono, framed, Fx, Fr }).slice(0, 4)) {
        const ll = lagsFromRhoDelta({ rho: c.rho, delta: c.delta, n1, n2, mainRate: Fx, referenceRate: Fr })
        tried.push({ l1: ll.lag1, l2: ll.lag2, score: c.score, origin: 'rescue' })
      }
    } catch { /* 忽略，下面统一拒绝 */ }
  }

  if (!tried.length) {
    throw new CalibrationRejected('无法在参考中找到两段校准声的对应位置（响动对应不唯一或参考不匹配）。请更换录音或校准区后重新确认。',
      { reason: 'no_correlation' })
  }

  const solutions = []
  for (const pair of tried) {
    const fit = refine(pair.l1, pair.l2)
    const cal = calibrationFromLags({ n1, n2, lag1: fit.l1, lag2: fit.l2, mainRate: Fx, referenceRate: Fr })
    solutions.push({ ...fit, cal, initScore: pair.score })
  }
  solutions.sort((a, b) => a.result.totalSSE - b.result.totalSSE)

  // 去重（映射差异小于 1ms 视同一解）。
  const distinct = []
  for (const sol of solutions) {
    if (distinct.every(d => Math.max(Math.abs(d.l1 - sol.l1), Math.abs(d.l2 - sol.l2)) > 0.001 * Fx)) distinct.push(sol)
  }
  if (!distinct.length) throw new CalibrationRejected('校准迭代未能收敛，请调整校准区后重试。', { reason: 'convergence' })

  const limits = segmentLevels.map(ls => ls.map(level => rmseLimit(level)))

  function rmsGate(sol) {
    const { result } = sol
    const rmsePass = result.rmse.every((pair, c) => pair.every((v, s) => v <= limits[s][c] + 1e-12))
    return { rmsePass, supportPass: result.support }
  }

  const evaluated = distinct.map(sol => ({ sol, ...rmsGate(sol) }))
  // 事件对齐检查只对通过 RMSE/覆盖的候选运行，避免重复的局部互相关开销。
  for (const item of evaluated) {
    if (item.rmsePass && item.supportPass) {
      item.events = eventAlignment(channels, Fx, refMono, item.sol.cal, framed)
      item.eventPass = item.events.vacant || item.events.maxErrorMs < 1
    } else {
      item.eventPass = false
    }
  }
  const passing = evaluated.filter(e => e.rmsePass && e.supportPass && e.eventPass)

  if (passing.length >= 2) {
    return rejectAmbiguity(passing, evaluated)
  }
  if (passing.length === 1) return buildAccepted(passing[0].sol, passing[0].events, {
    Fx, Fr, framed, segmentLevels, limits, main, reference, tried, distinct
  })

  // 救援：包络/名义候选都未达标时，跑降采样 k 网格全局搜索再试一次。
  if (passing.length === 0) {
    try {
      const rescueInits = coarseSearch({ main, refMono, framed, Fx, Fr })
        .map(c => {
          const ll = lagsFromRhoDelta({ rho: c.rho, delta: c.delta, n1, n2, mainRate: Fx, referenceRate: Fr })
          return { l1: ll.lag1, l2: ll.lag2, score: c.score, origin: 'rescue' }
        })
        .filter(init => tried.every(t => Math.max(Math.abs(t.l1 - init.l1), Math.abs(t.l2 - init.l2)) > 2))
        .slice(0, 4)
      const rescueEvaluated = []
      for (const init of rescueInits) {
        const fit = refine(init.l1, init.l2)
        const cal = calibrationFromLags({ n1, n2, lag1: fit.l1, lag2: fit.l2, mainRate: Fx, referenceRate: Fr })
        const sol = { ...fit, cal }
        const item = { sol, ...rmsGate(sol) }
        if (item.rmsePass && item.supportPass) {
          item.events = eventAlignment(channels, Fx, refMono, cal, framed)
          item.eventPass = item.events.vacant || item.events.maxErrorMs < 1
          if (item.eventPass) rescueEvaluated.push(item)
        }
        evaluated.push(item)
      }
      if (rescueEvaluated.length >= 2) return rejectAmbiguity(rescueEvaluated, evaluated)
      if (rescueEvaluated.length === 1) return buildAccepted(rescueEvaluated[0].sol, rescueEvaluated[0].events,
        { Fx, Fr, framed, segmentLevels, limits, main, reference, tried, distinct })
    } catch { /* 救援失败则进入统一拒绝说明 */ }
  }

  // 没有解同时达标：给出最佳解的逐项数据用于说明。
  evaluated.sort((a, b) => a.sol.result.totalSSE - b.sol.result.totalSSE)
  const best = evaluated[0]
  if (!best.events) best.events = eventAlignment(channels, Fx, refMono, best.sol.cal, framed)
  best.eventPass = best.events.vacant || best.events.maxErrorMs < 1
  const details = buildDetails(best.sol, best.events, { Fx, Fr, framed, segmentLevels, limits })
  const reasons = []
  if (!best.supportPass) reasons.push('参考未覆盖完整校准段')
  if (!best.rmsePass) reasons.push('校准均方根误差超过“电平 5% + 1 码”')
  if (!best.eventPass) {
    reasons.push(`同次响动对听偏差 ${best.events.maxErrorMs.toFixed(2)} 毫秒达到或超过 1 毫秒`)
  }
  throw new CalibrationRejected(`两段校准无法共同达标：${reasons.join('；')}。请更换录音或校准区后重新确认。`,
    { reason: 'joint_gate', ...details })
}

function rejectAmbiguity(passing, evaluated) {
  const maps = passing.slice(0, 4).map(p => ({ rho: p.sol.cal.rho, deltaSamples: p.sol.cal.delta }))
  throw new CalibrationRejected('响动对应不唯一：存在多个彼此相差超过 1 毫秒却同样达标的对齐。请改选响动更有特征的纯机器声片段，或更换参考后重新确认。',
    { reason: 'ambiguous_correspondence', candidates: maps })
}

function buildDetails(sol, events, ctx) {
  const { Fx, Fr, framed, segmentLevels, limits } = ctx
  return {
    segments: framed.map(([a, b], s) => ({
      start: a / Fx, end: b / Fx,
      channels: segmentLevels[s].map((level, c) => ({
        level, rmse: sol.result.rmse[c][s], limit: limits[s][c],
        ratio: sol.result.rmse[c][s] / level, pass: sol.result.rmse[c][s] <= limits[s][c] + 1e-12
      }))
    })),
    events
  }
}

function buildAccepted(sol, events, ctx) {
  const { Fx, Fr, framed, segmentLevels, limits, main, reference } = ctx
  const description = describeCalibration(sol.cal, Fx, Fr)
  const coverage = coverageInterval(sol.cal, main.frames, reference.frames, Fx, kernel.lobes)
  const coverageDisplay = coverageInterval(sol.cal, main.frames, reference.frames, Fx, 0)
  return {
    accepted: true,
    calibration: { ...description, gains: sol.result.gains },
    gains: sol.result.gains,
    rho: sol.cal.rho,
    delta: sol.cal.delta,
    coverage: coverageDisplay ? [{ start: coverageDisplay.start, end: coverageDisplay.end }] : [],
    processingCoverage: coverage ? { start: coverage.start, end: coverage.end } : null,
    segments: framed.map(([a, b], s) => ({
      start: a / Fx, end: b / Fx,
      channels: segmentLevels[s].map((level, c) => ({
        level, rmse: sol.result.rmse[c][s], limit: limits[s][c],
        ratio: sol.result.rmse[c][s] / level,
        codesRmse: sol.result.rmse[c][s] * 32768,
        limitCodes: limits[s][c] * 32768,
        pass: true
      }))
    })),
    events: {
      vacant: events.vacant,
      maxErrorMs: events.vacant ? 0 : events.maxErrorMs,
      localMaxMs: events.localMaxMs,
      onsetMaxMs: events.onsetMaxMs,
      pairs: events.pairs?.length ?? 0,
      pairDetails: (events.pairs ?? []).slice(0, 12),
      mainCount: events.mainCount,
      referenceCount: events.referenceCount,
      confidentBlocks: events.confidentBlocks
    },
    code: 'calibrated',
    codeUnit: CODE
  }
}
