export const BAND_EDGES = [20, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]

export function bands(rate) {
  const nyquist = rate / 2
  const list = []
  for (let i = 0; i < BAND_EDGES.length && BAND_EDGES[i] < nyquist; i++) {
    list.push({
      low: BAND_EDGES[i],
      high: i + 1 < BAND_EDGES.length ? Math.min(BAND_EDGES[i + 1], nyquist) : nyquist
    })
  }
  return list
}
