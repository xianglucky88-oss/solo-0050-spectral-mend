import { transform } from '../spectrum/transform.mjs'

function nextPow2(minimum) {
  let size = 1
  while (size < minimum) size *= 2
  return size
}

// 线性互相关：返回 corr[k] = sum_i x[i] * q[i + lag] 形式中 lag = k - xStart。
// 这里 x 从局部 0 开始；调用方用 xStart 换算全局偏移。
// 通过 FFT 计算，N >= x.length + q.length - 1。
export function correlate(x, q) {
  const n = nextPow2(x.length + q.length - 1)
  const real = new Float64Array(n), imag = new Float64Array(n)
  for (let i = 0; i < x.length; i++) real[i] = x[i]
  transform(real, imag, false)
  const qr = new Float64Array(n), qi = new Float64Array(n)
  for (let i = 0; i < q.length; i++) qr[i] = q[i]
  transform(qr, qi, false)
  // R = FFT(x) * conj(FFT(q))，逆变换给出循环相关，
  // r[d] = sum_j x[j] q[j + d]（线性区外按零处理）。
  for (let i = 0; i < n; i++) {
    const a = real[i], b = imag[i], c = qr[i], d = qi[i]
    real[i] = a * c + b * d
    imag[i] = b * c - a * d
  }
  transform(real, imag, true)
  // 整理成 lag 从 -(x.length-1) 到 q.length-1 的数组（契约 x[i] ~ q[i+lag]）。
  // 该 FFT 约定下：lag <= 0 位于下标 -lag；lag > 0 位于 n - lag。
  const minLag = -(x.length - 1)
  const maxLag = q.length - 1
  const lags = new Float64Array(maxLag - minLag + 1)
  for (let lag = minLag; lag <= maxLag; lag++) {
    const index = lag <= 0 ? -lag : n - lag
    lags[lag - minLag] = real[index]
  }
  return { lags, minLag }
}

// 归一化互相关候选峰。契约：最佳 lag 使 x[i] ≈ gain * q[i + lag]。
// 返回按 |ncc| 降序的前 limit 个互不相邻的候选（lag 单位与 q 索引一致）。
export function peakLags(x, q, { limit = 8, exclusion = 8, minNcc = 0.12, minOverlap = 0.6 } = {}) {
  const energyX = x.reduce((s, v) => s + v * v, 0)
  if (energyX <= 1e-14) return []
  const { lags, minLag } = correlate(x, q)
  // 双端能量前缀和，按 lag 取重叠区间的归一化能量。
  const prefixQ = new Float64Array(q.length + 1)
  for (let i = 0; i < q.length; i++) prefixQ[i + 1] = prefixQ[i] + q[i] * q[i]
  const prefixX = new Float64Array(x.length + 1)
  for (let i = 0; i < x.length; i++) prefixX[i + 1] = prefixX[i] + x[i] * x[i]
  const overlapEnergies = lag => {
    const i0 = Math.max(0, -lag)
    const i1 = Math.min(x.length, q.length - lag)
    if (i1 <= i0) return null
    return {
      count: i1 - i0,
      ex: prefixX[i1] - prefixX[i0],
      eq: prefixQ[i1 + lag] - prefixQ[i0 + lag]
    }
  }
  const candidates = []
  const at = lag => lags[lag - minLag]
  for (let k = 0; k < lags.length; k++) {
    const lag = k + minLag
    const cross = lags[k]
    if (cross === 0) continue
    const overlap = overlapEnergies(lag)
    if (!overlap || overlap.count < minOverlap * x.length || overlap.eq <= 1e-14 || overlap.ex <= 1e-14) continue
    const ncc = cross / Math.sqrt(overlap.ex * overlap.eq)
    if (Math.abs(ncc) < minNcc || Math.abs(ncc) > 1.05) continue
    // 抛物线亚采样修正。
    let shift = 0
    const ym = at(lag - 1), yp = at(lag + 1), y0 = at(lag)
    const denom = ym - 2 * y0 + yp
    if (denom !== 0 && Number.isFinite(ym) && Number.isFinite(yp)) {
      shift = Math.max(-1, Math.min(1, 0.5 * (ym - yp) / denom))
    }
    candidates.push({ lag, ncc, shift, fineLag: lag + shift })
  }
  candidates.sort((a, b) => Math.abs(b.ncc) - Math.abs(a.ncc))
  const picked = []
  for (const candidate of candidates) {
    if (picked.every(p => Math.abs(p.lag - candidate.lag) > exclusion)) picked.push(candidate)
    if (picked.length >= limit) break
  }
  return picked
}
