import { spectrumFrame } from './frame.mjs'

export function columns(audio, plan) {
  const starts = plan.starts.filter(start => start + plan.size / 2 >= 0 && start + plan.size / 2 < audio.frames)
  const width = Math.min(160, starts.length), bins = plan.size / 2 + 1
  const values = Array.from({ length: width }, () => Array(bins).fill(-100))
  const centers = []
  for (const [index, start] of starts.entries()) {
    const center = (start + plan.size / 2) / audio.rate
    const column = Math.floor(index * width / starts.length)
    if (!centers[column]) centers[column] = { first: center, last: center }
    else centers[column].last = center
    const frames = audio.tracks.map(track => spectrumFrame(track, start, plan))
    for (let k = 0; k < bins; k++) {
      const power = frames.reduce((sum, f) => sum + f.real[k] ** 2 + f.imaginary[k] ** 2, 0) / frames.length
      const scale = (k === 0 || k === bins - 1 ? 2 : 4) / plan.size
      const db = 10 * Math.log10(Math.max(1e-10, power * scale ** 2))
      values[column][k] = Math.max(values[column][k], Math.round(db))
    }
  }
  return { values, centers, binHz: audio.rate / plan.size, duration: audio.frames / audio.rate }
}
