// 连续位置采样：Kaiser 窗 sinc 插值。
// 核按小数相位预计算成表，批量校准/消声时每个采样只需若干次乘加。

function besselI0(x) {
  let sum = 1, term = 1
  const half = x / 2
  for (let k = 1; k < 40; k++) {
    term *= (half / k) ** 2
    sum += term
    if (term < 1e-16 * sum) break
  }
  return sum
}

function besselI1(x) {
  let sum = 0, term = x / 2
  sum += term
  const half = x / 2
  for (let k = 1; k < 40; k++) {
    term *= (half / (k + 1)) * half
    sum += term
    if (Math.abs(term) < 1e-16 * Math.abs(sum)) break
  }
  return sum
}

function sinc(d) {
  if (Math.abs(d) < 1e-12) return 1
  const pd = Math.PI * d
  return Math.sin(pd) / pd
}

function sincDerivative(d) {
  if (Math.abs(d) < 1e-9) return 0
  const pd = Math.PI * d
  return (pd * Math.cos(pd) - Math.sin(pd)) / (Math.PI * d * d)
}

const kernelCache = new Map()

export function makeKernel(lobes = 8, beta = 8.6, phases = 2048) {
  const key = `${lobes}:${beta}:${phases}`
  if (kernelCache.has(key)) return kernelCache.get(key)
  const taps = 2 * lobes
  const weights = new Float64Array((phases + 1) * taps)
  const derivs = new Float64Array((phases + 1) * taps)
  const denom = besselI0(beta)
  for (let p = 0; p <= phases; p++) {
    const frac = p / phases
    for (let t = 0; t < taps; t++) {
      const j = -lobes + 1 + t
      const d = frac - j
      const ad = Math.abs(d)
      let w = 1, wp = 0
      if (ad >= lobes) w = 0
      else if (ad > 1e-9) {
        const ratio = d / lobes
        const u = Math.sqrt(Math.max(0, 1 - ratio * ratio))
        const arg = beta * u
        w = besselI0(arg) / denom
        if (u > 1e-6) wp = (besselI1(arg) / denom) * beta * (-d / (lobes * lobes * u))
        else wp = -d * beta * beta / (2 * lobes * lobes) / denom
      }
      const h = sinc(d) * w
      const hd = sincDerivative(d) * w + sinc(d) * wp
      const index = p * taps + t
      weights[index] = h
      derivs[index] = hd
    }
  }
  const kernel = { lobes, taps, phases, weights, derivs }
  kernelCache.set(key, kernel)
  return kernel
}

// 使用核表的插值，返回 { y, dy }。边界按边缘采样延拓。
export function tablePair(kernel, buffer, pos) {
  const n = buffer.length
  if (n === 0) return { y: 0, dy: 0 }
  if (pos <= 0) return { y: buffer[0], dy: 0 }
  if (pos >= n - 1) return { y: buffer[n - 1], dy: 0 }
  let base = Math.floor(pos)
  let phase = Math.round((pos - base) * kernel.phases)
  if (phase === kernel.phases) { base += 1; phase = 0 }
  const wBase = phase * kernel.taps
  let y = 0, dy = 0
  for (let t = 0; t < kernel.taps; t++) {
    const j = -kernel.lobes + 1 + t
    let index = base + j
    if (index < 0) index = 0
    else if (index >= n) index = n - 1
    const value = buffer[index]
    y += value * kernel.weights[wBase + t]
    dy += value * kernel.derivs[wBase + t]
  }
  return { y, dy }
}

export function tableAt(kernel, buffer, pos) {
  return tablePair(kernel, buffer, pos).y
}

// 兼容直接调用（低频使用的工具/测试）。
const defaultKernel = makeKernel()
export function samplePair(buffer, pos, lobes = 8, beta = 8.6) {
  const kernel = lobes === 8 && beta === 8.6 ? defaultKernel : makeKernel(lobes, beta)
  return tablePair(kernel, buffer, pos)
}
export function sampleAt(buffer, pos, lobes = 8, beta = 8.6) {
  return samplePair(buffer, pos, lobes, beta).y
}
