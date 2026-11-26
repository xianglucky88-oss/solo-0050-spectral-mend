import { encode } from '../audio/encode.mjs'

// 内置录音：伴奏琶音 + 一段 260 Hz 机关平音（含两阶谐波与轻微响度起伏）。
export function glideDemo() {
  const rate = 16000, frames = rate * 3
  const tracks = [0, 1].map(channel => Float64Array.from({ length: frames }, (_, index) => {
    const time = index / rate
    const pad = [0.08, 0.06, 0.045].reduce((sum, amp, i) => sum + amp *
      Math.sin(2 * Math.PI * (220 * Math.pow(1.2, i)) * time + channel * 0.4), 0)
    const gate = Math.max(0, Math.min(1, (time - 0.55) * 30, (2.15 - time) * 30))
    const tremolo = 1 + 0.12 * Math.sin(2 * Math.PI * 7 * time + channel)
    const f0 = 260
    const tone = gate * tremolo * (0.16 * Math.sin(2 * Math.PI * f0 * time + channel * 0.5)
      + 0.08 * Math.sin(2 * Math.PI * 2 * f0 * time + 1.3 + channel * 0.5)
      + 0.04 * Math.sin(2 * Math.PI * 3 * f0 * time + 2.1 + channel * 0.5))
    return 0.8 * pad + tone
  }))
  const params = {
    start: 0.5, end: 2.2, low: 180, high: 360,
    orders: [1, 2, 3], sidebands: [22, 26, 26],
    targetStart: 260, targetEnd: 400,
  }
  return { wav: encode({ tracks, rate, frames }).toString('base64'), params }
}
