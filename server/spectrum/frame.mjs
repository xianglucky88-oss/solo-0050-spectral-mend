import { transform } from './transform.mjs'

export function spectrumFrame(track, start, plan) {
  const real = new Float64Array(plan.size), imaginary = new Float64Array(plan.size)
  for (let i = Math.max(0, -start); i < Math.min(plan.size, track.length - start); i++) {
    real[i] = track[start + i] * plan.window[i]
  }
  transform(real, imaginary)
  return { real, imaginary }
}
