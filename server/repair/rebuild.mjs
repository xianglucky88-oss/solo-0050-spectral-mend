import { transform } from '../spectrum/transform.mjs'
import { spectrumFrame } from '../spectrum/frame.mjs'
import { applyGains } from './mirror.mjs'

// Overlap-add reconstruction. `masks` maps a window start to a half-spectrum
// gain array; windows without an entry are passed through untouched, so a take
// with no mask comes back sample for sample.
export function render(audio, plan, masks) {
  if (masks.size === 0) {
    return { ...audio, tracks: audio.tracks.map(track => new Float64Array(track)), editedWindows: 0 }
  }
  const tracks = audio.tracks.map(() => new Float64Array(audio.frames))
  const weight = new Float64Array(audio.frames)
  let editedWindows = 0
  for (const start of plan.starts) {
    const mask = masks.get(start)
    if (mask) editedWindows++
    const first = Math.max(0, -start), end = Math.min(plan.size, audio.frames - start)
    for (let i = first; i < end; i++) weight[start + i] += plan.window[i] ** 2
    for (const [channel, track] of audio.tracks.entries()) {
      let frame
      if (mask) {
        frame = spectrumFrame(track, start, plan)
        applyGains(frame, mask)
        transform(frame.real, frame.imaginary, true)
      }
      for (let i = first; i < end; i++) {
        const sample = frame ? frame.real[i] : track[start + i] * plan.window[i]
        tracks[channel][start + i] += plan.window[i] * sample
      }
    }
  }
  for (const track of tracks) for (let i = 0; i < track.length; i++) track[i] /= weight[i]
  return { ...audio, tracks, editedWindows }
}
