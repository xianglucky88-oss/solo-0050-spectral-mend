import { applyTaps, eigenSymmetric, solveTaps, sumAbs, TAPS } from './linalg.mjs'

/** 单位脉冲串入绝对值之和上限：原幅值的一半。 */
export const MAX_GAIN = 0.5
/** 入选段逐帧预测误差上限：该段直达峰值的 1%。 */
export const ERROR_RATIO = 0.01
/** 有声判定的绝对下限（略高于量化底噪）。 */
const VOICED_FLOOR = 2 / 32768
/** 有声判定的相对下限（相对全片峰值）。 */
const VOICED_RELATIVE = 2e-4
/** 总误差并列的数值容差。 */
const SCORE_TIE = 1e-9
/** 视为“数据几乎无法约束”的相对特征值阈值。 */
const NEAR_NULL = 1e-6

export function segmentPeak(track, segment) {
  let peak = 0
  for (let n = segment.startFrame; n < segment.endFrame; n++) peak = Math.max(peak, Math.abs(track[n]))
  return peak
}

/** 目标声道第 n 帧由源声道最近 1–8 帧历史解释的回归行。 */
export function rowFor(track, n) {
  const row = new Float64Array(TAPS)
  for (let k = 1; k <= TAPS; k++) row[k - 1] = n - k >= 0 ? track[n - k] : 0
  return row
}

export function pcm16(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value * 32768)))
}

/** 一段的逐帧最大误差与平方误差和。 */
export function measure(taps, segment, source, victim) {
  let maxError = 0, sse = 0
  for (let n = segment.startFrame; n < segment.endFrame; n++) {
    const error = victim[n] - applyTaps(taps, rowFor(source, n))
    const magnitude = Math.abs(error)
    if (magnitude > maxError) maxError = magnitude
    sse += error * error
  }
  return { maxError, sse }
}

/** 在一组段上展开回归行与目标，供反复评估。 */
export function design(segments, source, victim) {
  const rows = [], targets = []
  for (const segment of segments) {
    for (let n = segment.startFrame; n < segment.endFrame; n++) {
      rows.push(rowFor(source, n))
      targets.push(victim[n])
    }
  }
  return { rows, targets }
}

export function predict(taps, rows) {
  const out = new Int32Array(rows.length)
  for (let r = 0; r < rows.length; r++) out[r] = pcm16(applyTaps(taps, rows[r]))
  return out
}

export function sameVector(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function subsets(items, minimum) {
  const result = []
  const total = 1 << items.length
  for (let mask = 1; mask < total; mask++) {
    const subset = items.filter((_, index) => mask & (1 << index))
    if (subset.length >= minimum) result.push(subset)
  }
  return result
}

function shifted(taps, scale, direction) {
  const out = Float64Array.from(taps)
  for (let i = 0; i < out.length; i++) out[i] += scale * direction[i]
  return out
}

function gramOf(rows) {
  const gram = Array.from({ length: TAPS }, () => new Float64Array(TAPS))
  for (const row of rows) for (let i = 0; i < TAPS; i++) for (let j = i; j < TAPS; j++) gram[i][j] += row[i] * row[j]
  for (let i = 0; i < TAPS; i++) for (let j = 0; j < i; j++) gram[i][j] = gram[j][i]
  return gram
}

/**
 * 同一采用段组内，沿设计矩阵的近零特征方向寻找与基准解释“PCM16 预测逐样
 * 相同”的最大可行扰动。收益是：这些滤波器同样解释该组的全部段，却可能
 * 改变节目还原，构成“同组预测逐样相同”歧义。
 */
function identicalPredictionAlternatives(bestTaps, rows, baseVector) {
  const { values, vectors } = eigenSymmetric(gramOf(rows))
  const largest = values.length ? Math.max(0, values[values.length - 1]) : 0
  if (largest <= 0) return []
  const alternatives = []
  for (let index = 0; index < values.length; index++) {
    if (values[index] > largest * NEAR_NULL) continue
    const direction = vectors[index]
    for (const sign of [1, -1]) {
      let good = 0, bad = 0
      for (let step = 1; step <= 16; step++) {
        const scale = Math.min(2, 2 ** (step - 12))
        const candidate = shifted(bestTaps, sign * scale, direction)
        if (sumAbs(candidate) > MAX_GAIN + 1e-9) break
        if (sameVector(predict(candidate, rows), baseVector)) good = scale
        else { bad = scale; break }
      }
      if (good === 0) continue
      if (bad === 0) bad = Math.min(2, good * 2)
      for (let step = 0; step < 30; step++) {
        const middle = (good + bad) / 2
        const candidate = shifted(bestTaps, sign * middle, direction)
        if (sumAbs(candidate) <= MAX_GAIN + 1e-9 && sameVector(predict(candidate, rows), baseVector)) good = middle
        else bad = middle
      }
      alternatives.push(shifted(bestTaps, sign * good, direction))
    }
  }
  return alternatives
}

export function globalPeakOf(tracks) {
  let peak = 0
  for (const track of tracks) for (let i = 0; i < track.length; i++) peak = Math.max(peak, Math.abs(track[i]))
  return peak
}

function fitsBudget(taps) {
  return sumAbs(taps) <= MAX_GAIN + 1e-9
}

/**
 * 单方向校准。source 为该方向独奏所在的声道，victim 为受串入的声道：
 * 该方向的独奏段全部属于 source，victim 在其中应保持安静。
 *
 * 关系在每一个非空独奏子集上拟合，每个候选滤波器都在**全部**有声独奏上
 * 评估：以“能解释的有声段数”衡量支持度，取支持度最高者（至少两段）；
 * 同一组采用段内再按“各段直达峰值归一的总平方误差”取最低者。
 *
 * 返回值：
 * - filter / adopted：采用的关系与其采用段；
 * - explanations：其余最大支持解释。它们覆盖三种触发歧义的情形——
 *   不同采用段组；同组预测 PCM16 逐样相同；同组总误差并列最低。
 *   上层固定另一方向后据此比较节目还原，判定是否歧义。
 */
export function calibrateDirection(source, victim, segments, globalPeak = 1) {
  const peaks = segments.map(segment => segmentPeak(source, segment))
  const threshold = Math.max(VOICED_FLOOR, VOICED_RELATIVE * globalPeak)
  const voiced = segments.map((_, index) => index).filter(index => peaks[index] > threshold)
  const base = { peaks, voiced, adopted: [], support: 0, filter: null, score: null,
    adoptedSegments: [], explanations: [], maxErrorRatio: null }

  if (voiced.length < 2) {
    return { ...base, status: 'insufficient',
      message: voiced.length === 0
        ? '该方向没有有声独奏，缺少校准证据。'
        : `该方向只有 ${voiced.length} 段有声独奏，不足两段，无法校准。` }
  }

  // 候选：在每一个非空独奏子集上求受 L1 约束的最小范数最小二乘，再到全部
  // 有声段评估解释力。子集大小与“采用段数”无关——一个干净的段落可能单独
  // 定出关系，再去解释其它段；这正是歧义情形的来源。
  const evaluations = []
  for (const subset of subsets(voiced, 1)) {
    const chosen = subset.map(index => segments[index])
    const { rows, targets } = design(chosen, source, victim)
    const solution = solveTaps(rows, targets, MAX_GAIN)
    if (!fitsBudget(solution.taps)) continue
    const errors = segments.map(segment => measure(solution.taps, segment, source, victim))
    const adopted = voiced.filter(index => errors[index].maxError <= ERROR_RATIO * peaks[index])
    if (adopted.length < 2) continue
    const score = adopted.reduce((sum, index) => sum + errors[index].sse / (peaks[index] ** 2), 0)
    evaluations.push({ adopted, groupKey: adopted.join(','), taps: solution.taps,
      score, sumAbs: sumAbs(solution.taps) })
  }

  if (evaluations.length === 0) {
    return { ...base, status: 'inconsistent',
      message: '该方向的有声独奏之间找不到能互相印证、且满足串入增益上限的串漏关系。' }
  }

  const support = Math.max(...evaluations.map(entry => entry.adopted.length))
  const top = evaluations.filter(entry => entry.adopted.length === support)

  // 按采用段组归并；每组内取归一误差最低者作为该组代表。
  const groups = new Map()
  for (const entry of top) {
    const group = groups.get(entry.groupKey)
    if (!group || entry.score < group.score - SCORE_TIE) groups.set(entry.groupKey, entry)
  }
  const groupList = [...groups.values()].sort((a, b) => a.score - b.score || a.sumAbs - b.sumAbs)
  const best = groupList[0]
  const tolerance = Math.max(Math.abs(best.score) * SCORE_TIE, SCORE_TIE)

  const bestSegments = best.adopted.map(index => segments[index])
  const { rows: bestRows } = design(bestSegments, source, victim)
  const canonical = predict(best.taps, bestRows)

  const explanations = []
  const recorded = new Set([Array.from(best.taps, value => value.toFixed(12)).join(',')])
  const push = (taps, reason, groupKey) => {
    if (!fitsBudget(taps)) return
    const key = Array.from(taps, value => value.toFixed(12)).join(',')
    if (recorded.has(key)) return
    recorded.add(key)
    explanations.push({ taps: Float64Array.from(taps), reason, groupKey })
  }

  // 情形一：不同采用段组，且同为最大支持。
  for (const group of groupList.slice(1)) push(group.taps, 'different-group', group.groupKey)

  // 情形二：同组预测 PCM16 逐样相同。
  for (const taps of identicalPredictionAlternatives(best.taps, bestRows, canonical)) {
    push(taps, 'identical-prediction', best.groupKey)
  }
  // 同组、且在校准区 PCM16 预测与基准逐样相同的其它候选（即使浮点误差不同）。
  for (const entry of top) {
    if (entry.groupKey !== best.groupKey) continue
    if (sameVector(predict(entry.taps, bestRows), canonical)) push(entry.taps, 'identical-prediction', best.groupKey)
  }

  // 情形三：同组总误差并列最低。
  for (const entry of top) {
    if (entry.groupKey !== best.groupKey || entry === best) continue
    if (entry.score <= best.score + tolerance) push(entry.taps, 'tied-score', best.groupKey)
  }

  const bestErrors = segments.map(segment => measure(best.taps, segment, source, victim))
  const describe = index => ({
    index, start: segments[index].start, end: segments[index].end,
    startFrame: segments[index].startFrame, endFrame: segments[index].endFrame,
    peak: peaks[index], maxError: bestErrors[index].maxError,
    errorRatio: bestErrors[index].maxError / peaks[index]
  })
  return {
    ...base,
    status: 'ok',
    adopted: best.adopted,
    support,
    filter: best.taps,
    score: best.score,
    adoptedSegments: best.adopted.map(describe),
    groups: groupList.map(group => ({ adopted: group.adopted, score: group.score, sumAbs: group.sumAbs })),
    maxErrorRatio: Math.max(...best.adopted.map(index => bestErrors[index].maxError / peaks[index])),
    explanations
  }
}
