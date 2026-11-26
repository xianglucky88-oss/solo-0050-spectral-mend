const stops = [[17,18,37],[64,42,104],[159,66,119],[238,130,111],[255,225,155]]

export function spectralColor(db) {
  const scaled = Math.min(0.999999, Math.max(0, (db + 88) / 88)) * (stops.length - 1)
  const low = Math.floor(scaled), phase = scaled - low
  return stops[low].map((value, i) => Math.round(value + (stops[low + 1][i] - value) * phase))
}
