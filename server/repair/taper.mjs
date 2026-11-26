export function taper(value, low, high, margin, limits) {
  if (value < low || value > high) return 0
  const fromStart = low === limits[0] ? 1 : (value - low) / margin
  const fromEnd = high === limits[1] ? 1 : (high - value) / margin
  const t = Math.min(1, fromStart, fromEnd)
  return .5 - .5 * Math.cos(Math.PI * t)
}
