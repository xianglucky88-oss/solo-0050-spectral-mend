import { encode } from '../audio/encode.mjs'

export function demo() {
  const rate = 16000, frames = Math.round(rate * 3.6)
  const tracks = [new Float64Array(frames), new Float64Array(frames)]
  const notes = [659.25, 783.99, 880, 783.99, 659.25]
  for (let i = 0; i < frames; i++) {
    const t = i / rate
    const pad = 0.16 * Math.sin(2 * Math.PI * 98 * t)
      + 0.10 * Math.sin(2 * Math.PI * 147 * t + 0.6)
      + 0.07 * Math.sin(2 * Math.PI * 196 * t + 1.3)
    tracks[0][i] += pad
    tracks[1][i] += pad
    const slot = (t - 0.8) / 0.4
    const note = Math.floor(slot)
    if (note >= 0 && note < notes.length) {
      const local = t - 0.8 - note * 0.4
      const env = Math.min(1, local / 0.02, (0.4 - local) / 0.02)
      const tone = 0.30 * env * Math.sin(2 * Math.PI * notes[note] * t)
      tracks[0][i] += tone
      tracks[1][i] -= tone
    }
    const shake = (t - 0.5) % 0.6
    if (t >= 0.5 && shake < 0.06) {
      const env = Math.min(1, shake / 0.01, (0.06 - shake) / 0.01)
      let hiss = 0
      for (let k = 0; k < 5; k++) hiss += 0.05 * Math.sin(2 * Math.PI * (2600 + 200 * k) * t + k * 1.7)
      tracks[0][i] += env * hiss
    }
    if (t >= 2.4 && t < 2.95) {
      const tau = t - 2.4
      const gate = .5 - .5 * Math.cos(Math.PI * Math.min(1, tau / 0.03, (0.55 - tau) / 0.06))
      tracks[1][i] += 0.20 * gate * Math.sin(2 * Math.PI * 180 * tau) * Math.exp(-6 * tau)
    }
    const edge = Math.min(1, t / 0.02, (frames / rate - t) / 0.02)
    tracks[0][i] *= edge
    tracks[1][i] *= edge
  }
  return { wav: encode({ tracks, rate, frames }).toString('base64'), circle: { start: 0.7, end: 3.0 } }
}
