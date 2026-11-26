import { taper } from './taper.mjs'

export function gains(plan, audio, start, regions) {
  const duration = audio.frames / audio.rate, nyquist = audio.rate / 2
  const time = Math.min(duration, Math.max(0, (start + plan.size / 2) / audio.rate))
  const active = regions.map(region => ({ ...region, timeWeight: taper(time, region.start, region.end,
    Math.min(plan.hop / audio.rate, (region.end - region.start) / 3), [0, duration]) })).filter(region => region.timeWeight && region.db)
  if (active.length === 0) return null
  const result = new Float64Array(plan.size / 2 + 1)
  let changed = false
  for (let k = 0; k < result.length; k++) {
    const freq = k * audio.rate / plan.size
    const db = active.reduce((sum, region) => sum + region.db * region.timeWeight * taper(freq, region.low, region.high,
      Math.min(audio.rate / plan.size, (region.high - region.low) / 3), [0, nyquist]), 0)
    result[k] = 10 ** (-db / 20)
    changed ||= db > 0
  }
  return changed ? result : null
}
