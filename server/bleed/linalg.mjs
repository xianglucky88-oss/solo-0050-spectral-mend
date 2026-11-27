/**
 * 小型密集线性代数。串漏滤波器只有 1–8 帧延迟抽头，法方程恒为 8×8，
 * 直接用对称特征分解求最小范数最小二乘。
 *
 * 特征值分解同时给出数据无法约束的零空间方向：沿这些方向改变滤波器
 * 不会改变校准段上的预测（因此 PCM16 预测逐样相同），却可能改变节目
 * 还原，上层据此判定歧义。
 */

export const TAPS = 8
const MAX_SWEEPS = 100

export function dot(a, b) {
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i]
  return sum
}

/** Jacobi 对称特征分解，返回按特征值升序排列的特征对。 */
export function eigenSymmetric(input) {
  const n = input.length
  const a = input.map(row => Float64Array.from(row))
  const vectors = Array.from({ length: n }, (_, i) =>
    Float64Array.from({ length: n }, (_, j) => i === j ? 1 : 0))
  for (let sweep = 0; sweep < MAX_SWEEPS; sweep++) {
    let off = 0
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p][q] ** 2
    if (off < 1e-30) break
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(a[p][q]) < 1e-300) continue
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
        const sign = theta >= 0 ? 1 : -1
        const t = sign / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
        const c = 1 / Math.sqrt(t * t + 1), s = t * c
        for (let k = 0; k < n; k++) {
          const akp = a[k][p], akq = a[k][q]
          a[k][p] = c * akp - s * akq
          a[k][q] = s * akp + c * akq
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p][k], aqk = a[q][k]
          a[p][k] = c * apk - s * aqk
          a[q][k] = s * apk + c * aqk
        }
        for (let k = 0; k < n; k++) {
          const vkp = vectors[k][p], vkq = vectors[k][q]
          vectors[k][p] = c * vkp - s * vkq
          vectors[k][q] = s * vkp + c * vkq
        }
      }
    }
  }
  const order = Array.from({ length: n }, (_, i) => i).sort((i, j) => a[i][i] - a[j][j])
  return {
    values: Float64Array.from(order, i => a[i][i]),
    vectors: order.map(i => Float64Array.from({ length: n }, (_, k) => vectors[k][i]))
  }
}

/** 由回归行构造法方程矩阵与右端项。 */
export function normalEquations(rows, targets) {
  const gram = Array.from({ length: TAPS }, () => new Float64Array(TAPS))
  const rhs = new Float64Array(TAPS)
  for (let r = 0; r < rows.length; r++) {
    const row = rows[r], y = targets[r]
    for (let i = 0; i < TAPS; i++) {
      if (row[i] === 0) continue
      rhs[i] += row[i] * y
      for (let j = i; j < TAPS; j++) gram[i][j] += row[i] * row[j]
    }
  }
  for (let i = 0; i < TAPS; i++) for (let j = 0; j < i; j++) gram[i][j] = gram[j][i]
  return { gram, rhs }
}

/** 欧氏投影到 L1 球 |h|_1 ≤ radius。球内的向量原样返回。 */
export function projectL1(vector, radius) {
  const magnitudes = Array.from(vector, Math.abs)
  const total = magnitudes.reduce((sum, value) => sum + value, 0)
  if (total <= radius) return Float64Array.from(vector)
  const sorted = [...magnitudes].sort((a, b) => b - a)
  let cumulative = 0, tau = 0
  for (let i = 0; i < sorted.length; i++) {
    cumulative += sorted[i]
    const candidate = (cumulative - radius) / (i + 1)
    if (sorted[i] - candidate > 0) tau = candidate
    else break
  }
  const result = new Float64Array(vector.length)
  for (let i = 0; i < vector.length; i++) {
    const shrunk = magnitudes[i] - tau
    result[i] = shrunk > 0 ? Math.sign(vector[i]) * shrunk : 0
  }
  return result
}

export function sumAbs(taps) {
  let sum = 0
  for (const value of taps) sum += Math.abs(value)
  return sum
}

function residual(rows, targets, taps) {
  let sse = 0
  for (let r = 0; r < rows.length; r++) {
    let predicted = 0
    for (let k = 0; k < TAPS; k++) predicted += rows[r][k] * taps[k]
    sse += (targets[r] - predicted) ** 2
  }
  return sse
}

export const RELATIVE_RANK = 1e-9

/**
 * 最小范数最小二乘，可选 L1 球约束。返回抽头、残差、秩与零空间方向。
 * 无约束解由特征分解直接给出；若其 L1 超过上限，改用投影梯度在 L1
 * 球上求解，得到可行且误差尽可能小的滤波器。
 */
export function solveTaps(rows, targets, maxL1 = Infinity) {
  const { gram, rhs } = normalEquations(rows, targets)
  const { values, vectors } = eigenSymmetric(gram)
  const largest = values.length ? Math.max(0, values[values.length - 1]) : 0
  const cutoff = largest > 0 ? largest * RELATIVE_RANK : 0
  const nullspace = vectors.filter((_, index) => values[index] <= cutoff)

  let taps = new Float64Array(TAPS)
  let rank = 0
  for (let index = 0; index < values.length; index++) {
    if (values[index] <= cutoff) continue
    const projection = dot(vectors[index], rhs) / values[index]
    for (let k = 0; k < TAPS; k++) taps[k] += projection * vectors[index][k]
    rank++
  }
  let constrained = false
  if (Number.isFinite(maxL1) && sumAbs(taps) > maxL1 + 1e-12) {
    constrained = true
    const lipschitz = largest > 0 ? largest : 1
    const step = 1 / lipschitz
    taps = new Float64Array(TAPS)
    for (let iteration = 0; iteration < 20000; iteration++) {
      const gradient = new Float64Array(TAPS)
      for (let i = 0; i < TAPS; i++) {
        let value = -rhs[i]
        for (let j = 0; j < TAPS; j++) value += gram[i][j] * taps[j]
        gradient[i] = value
      }
      let movement = 0
      const next = new Float64Array(TAPS)
      for (let i = 0; i < TAPS; i++) { next[i] = taps[i] - step * gradient[i]; movement += gradient[i] ** 2 }
      taps = projectL1(next, maxL1)
      if (movement < 1e-30) break
    }
  }
  return { taps, sse: residual(rows, targets, taps), rank, constrained,
    nullspace, eigenvalues: values, cutoff }
}

export function applyTaps(taps, row) {
  let sum = 0
  const length = Math.min(row.length, taps.length)
  for (let k = 0; k < length; k++) sum += taps[k] * row[k]
  return sum
}
