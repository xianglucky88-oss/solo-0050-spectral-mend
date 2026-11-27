import { spectrumFrame } from './frame.mjs'

export function powerSpectrum(audio, start, plan) {
  const bins = plan.size / 2 + 1
  const values = new Array(bins).fill(-100)
  const frames = audio.tracks.map(track => spectrumFrame(track, start, plan))
  for (let k = 0; k < bins; k++) {
    const power = frames.reduce((sum, frame) => sum + frame.real[k] ** 2 + frame.imaginary[k] ** 2, 0) / frames.length
    const scale = (k === 0 || k === bins - 1 ? 2 : 4) / plan.size
    values[k] = 10 * Math.log10(Math.max(1e-10, power * scale ** 2))
  }
  return values
}
