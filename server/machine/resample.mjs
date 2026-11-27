import { besselI0Export } from './bessel.mjs'

// 带抗混叠的重采样：降采样时把核带宽缩到目标采样率的奈奎斯特以内。
// 仅用于粗对齐；最终参数由全速率高斯-牛顿迭代精修。
export function resampleBandlimited(buffer, inRate, outRate) {
  if (outRate >= inRate - 1) {
    const length = Math.round(buffer.length * outRate / inRate)
    const out = new Float64Array(length)
    const step = inRate / outRate
    for (let i = 0; i < length; i++) {
      const pos = i * step
      const i0 = Math.floor(pos), f = pos - i0
      const a = buffer[Math.min(buffer.length - 1, Math.max(0, i0))]
      const b = buffer[Math.min(buffer.length - 1, Math.max(0, i0 + 1))]
      out[i] = a + (b - a) * f
    }
    return out
  }
  const step = inRate / outRate // 每个输出采样跨越的输入采样数
  const cutoff = 0.5 / step // 归一化截止（周期/输入采样）
  const lobes = 5
  const width = lobes * step // 输入采样半宽
  const beta = 7.4
  const denom = besselI0Export(beta)
  const length = Math.max(1, Math.floor(buffer.length / step))
  const out = new Float64Array(length)
  for (let i = 0; i < length; i++) {
    const pos = i * step
    const center = Math.round(pos)
    let sum = 0
    const lo = Math.max(0, Math.ceil(pos - width)), hi = Math.min(buffer.length - 1, Math.floor(pos + width))
    for (let j = lo; j <= hi; j++) {
      const d = pos - j
      const ad = Math.abs(d)
      if (ad > width) continue
      const x = 2 * cutoff * d
      const sinc = Math.abs(x) < 1e-12 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)
      const u = Math.sqrt(Math.max(0, 1 - (d / width) ** 2))
      const window = besselI0Export(beta * u) / denom
      sum += buffer[j] * (2 * cutoff * sinc) * window
    }
    out[i] = sum
  }
  return out
}
