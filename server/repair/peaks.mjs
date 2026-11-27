// Finds local spectral maxima in a frequency band and refines them with a
// parabolic fit. A peak is only reported when it stands clear of the loudest
// bin in the band, which keeps window side lobes and numerical noise out of
// the hum route.
export function detectPeaks(values, low, high, binHz, options = {}) {
  const { prominence = 30, minimumLevel = -88 } = options
  const bins = values.length
  const first = Math.max(1, Math.ceil(low / binHz))
  const last = Math.min(bins - 2, Math.floor(high / binHz))
  if (!(last >= first)) return []
  let loudest = -Infinity
  for (let k = first; k <= last; k++) loudest = Math.max(loudest, values[k])
  if (!Number.isFinite(loudest) || loudest < minimumLevel) return []
  const threshold = loudest - prominence
  const peaks = []
  for (let k = first; k <= last; k++) {
    if (!(values[k] > values[k - 1] && values[k] >= values[k + 1] && values[k] >= threshold)) continue
    const left = values[k - 1], middle = values[k], right = values[k + 1]
    const curvature = left - 2 * middle + right
    let offset = curvature ? 0.5 * (left - right) / curvature : 0
    offset = Math.max(-.5, Math.min(.5, offset))
    peaks.push({
      bin: k,
      offset,
      frequency: (k + offset) * binHz,
      level: middle - .25 * (left - right) * offset,
      width: widthAt(values, k, 6)
    })
  }
  return peaks.sort((a, b) => b.level - a.level)
}

// Number of bins in the contiguous -drop dB shoulder around bin k. A merged
// pair widens this shoulder; a lone narrow tone does not.
function widthAt(values, k, drop) {
  const floor = values[k] - drop
  let left = k, right = k
  while (left > 0 && values[left - 1] >= floor) left--
  while (right < values.length - 1 && values[right + 1] >= floor) right++
  return right - left + 1
}
