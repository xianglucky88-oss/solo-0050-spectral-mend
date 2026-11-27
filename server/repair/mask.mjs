// Builds the attenuation mask for one analysis window of a confirmed hum
// segment. The notch has a flat floor over the hum's own bins and a short
// cosine shoulder, so a companion tone four bins away keeps unity gain while
// the hum line is removed. A small guard band is added to the requested depth
// so overlap-add and sub-bin peaks can never leave the measured drop below the
// 6 dB floor.
export function notchMask(plan, binHz, frequency, depth, factor = 1) {
  const bins = plan.size / 2 + 1
  const gain = new Float64Array(bins).fill(1)
  if (!(depth > 0) || !(factor > 0)) return gain
  const target = Math.min(72, depth + .25)
  const floor = 10 ** (-target * factor / 20)
  const center = frequency / binHz
  const flat = 2, shoulder = 3
  for (let k = 0; k < bins; k++) {
    const distance = Math.abs(k - center)
    if (distance <= flat) gain[k] = floor
    else if (distance < shoulder) {
      const phase = (distance - flat) / (shoulder - flat)
      gain[k] = floor + (1 - floor) * (.5 - .5 * Math.cos(Math.PI * phase))
    }
  }
  return gain
}

// Edge ramp so the edit fades smoothly back into the original take. With a
// margin of 1.5 windows the first and last windows carry reduced depth while
// the center window of a run of three or more always carries full depth, so a
// verification window never sits on a transition.
export function windowFactor(index, count, margin = 1.5) {
  const fromStart = (index + .5) / margin
  const fromEnd = (count - index - .5) / margin
  return .5 - .5 * Math.cos(Math.PI * Math.min(1, fromStart, fromEnd))
}
