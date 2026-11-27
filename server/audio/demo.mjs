import { encode } from './encode.mjs'

// Built-in take: a device hum sweeps upward across a steady companion tone,
// so the two lines merge around the crossing and separate again. The hum also
// drops out briefly before the crossing to leave an unconfirmed gap.
export function demo() {
  const rate = 16000, frames = rate * 3
  const sweepStart = 0.55, sweepEnd = 2.45
  const low = 1420, high = 1780
  const tracks = [0, 1].map(channel => Float64Array.from({ length: frames }, (_, index) => {
    const time = index / rate
    const gain = Math.min(1, time * 12, (3 - time) * 12)
    const voice = [192, 293, 401].reduce((sum, hz, i) => sum + 0.10 / (i + 1) *
      Math.sin(2 * Math.PI * hz * time + 0.9 * Math.sin(2 * Math.PI * (2 + i) * time + channel)), 0)
    const humEnvelope = Math.max(0, Math.min(1, (time - sweepStart) / 0.08, (sweepEnd - time) / 0.08))
      * (time > 0.95 && time < 1.0 ? 0.02 : 1)
    const progress = Math.min(1, Math.max(0, (time - sweepStart) / (sweepEnd - sweepStart)))
    const phase = 2 * Math.PI * (low * (time - sweepStart) +
      (high - low) * (time - sweepStart) ** 2 / (2 * (sweepEnd - sweepStart)))
    const hum = humEnvelope * (channel === 0 ? .16 : .12) * Math.sin(phase + channel * 0.6)
    const companionEnvelope = Math.max(0, Math.min(1, (time - 0.35) / 0.08, (2.65 - time) / 0.08))
    const companionLevel = 0.72 + 0.5 * Math.sin(2 * Math.PI * 0.45 * time + 0.3)
    const companion = companionEnvelope * (channel === 0 ? .19 : .15) * companionLevel *
      Math.sin(2 * Math.PI * 1600 * time + 0.4 + channel * 0.5)
    return voice * gain + hum + companion
  }))
  return {
    wav: encode({ tracks, rate, frames }).toString('base64'),
    region: { start: 0.63, end: 2.12, low: 1400, high: 1800, db: 26 },
    // Suggested circle and hum points for the page only; deliberately not named
    // `trace`, so a client that forwards this object to repair still gets the
    // plain rectangle/旁路 behaviour.
    preset: {
      range: { start: 0.55, end: 2.45, low: 1360, high: 1840 },
      points: [{ time: 0.75, frequency: 1458 }, { time: 2.25, frequency: 1742 }],
      db: 18
    }
  }
}
