import { encode } from './encode.mjs'

export function demo() {
  const rate = 16000, frames = rate * 3
  const tracks = [0,1].map(channel => Float64Array.from({ length: frames }, (_, index) => {
    const time = index / rate
    const gain = Math.min(1, time * 12, (3 - time) * 12)
    const voice = [192,293,401].reduce((sum, hz, i) => sum + 0.12 / (i + 1) *
      Math.sin(2 * Math.PI * hz * time + 0.9 * Math.sin(2 * Math.PI * (2 + i) * time + channel)), 0)
    const hum = Math.max(0, Math.min(1, (time - 0.7) * 40, (2.05 - time) * 40))
      * (channel === 0 ? .27 : .20) * Math.sin(2 * Math.PI * 1600 * time + channel)
    return voice * gain + hum
  }))
  return { wav: encode({ tracks, rate, frames }).toString('base64'),
    region: { start: 0.63, end: 2.12, low: 1450, high: 1750, db: 26 } }
}
