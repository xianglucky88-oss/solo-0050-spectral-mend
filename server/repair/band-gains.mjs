import { taper } from './taper.mjs'

// 长录音模式：增益只在选框内部平滑渐变；框外频格的增益严格等于 1，
// 重建阶段会原样保留这些采样。多个选区仍在分贝域累加。
// 时间使用窗中心的真实时间（不夹边），使分段处理与整段处理一致。
export function bandGains(plan, rate, frames, centerTime, regions) {
  const duration = frames / rate, nyquist = rate / 2
  const active = regions.map(region => ({ ...region, timeWeight: taper(centerTime, region.start, region.end,
    Math.min(plan.hop / rate, (region.end - region.start) / 3), [0, duration]) }))
    .filter(region => region.timeWeight && region.db)
  if (active.length === 0) return null
  const result = new Float64Array(plan.size / 2 + 1)
  let changed = false
  for (let k = 0; k < result.length; k++) {
    const freq = k * rate / plan.size
    const db = active.reduce((sum, region) => sum + region.db * region.timeWeight * taper(freq, region.low, region.high,
      Math.min(rate / plan.size, (region.high - region.low) / 3), [0, nyquist]), 0)
    result[k] = 10 ** (-db / 20)
    changed ||= db > 0
  }
  return changed ? result : null
}
