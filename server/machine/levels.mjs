export function rms(values, start = 0, end = values.length) {
  let sum = 0
  const from = Math.max(0, Math.floor(start))
  const to = Math.min(values.length, Math.ceil(end))
  const count = to - from
  if (count <= 0) return 0
  for (let i = from; i < to; i++) sum += values[i] * values[i]
  return Math.sqrt(sum / count)
}

export function peakAbs(values, start = 0, end = values.length) {
  let peak = 0
  for (let i = Math.max(0, Math.floor(start)); i < Math.min(values.length, Math.ceil(end)); i++) {
    peak = Math.max(peak, Math.abs(values[i]))
  }
  return peak
}

export const CODE = 1 / 32768

// 校准合格线：该段该路电平（RMS）的 5% 加 1 码。
export function rmseLimit(level) {
  return 0.05 * level + CODE
}
