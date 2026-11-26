import { encode } from './encode.mjs'
import { encodePcm16Wav } from './pcm16.mjs'

// 在整数 PCM 声道上放下一个确定性的削平平顶，并把紧邻外侧样值压低，
// 使其成为“两侧都有有效波形”的可补整段。
function placeFlat(pcm, channel, rate, time, length, level, sign = 1) {
  const track = pcm[channel]
  const start = Math.round(time * rate)
  const end = start + length - 1
  for (let i = start; i <= end; i++) track[i] = sign * level
  if (start - 1 >= 0) track[start - 1] = sign * Math.round(level * 0.72)
  if (start - 2 >= 0) track[start - 2] = sign * Math.round(level * 0.5)
  if (end + 1 < track.length) track[end + 1] = sign * Math.round(level * 0.7)
  if (end + 2 < track.length) track[end + 2] = sign * Math.round(level * 0.48)
  return { channel, start, end }
}

// 放下单个满幅瞬态：只有一个满幅样点，两侧刻意压低，确保不形成平顶。
function placeSpike(pcm, channel, rate, time, sign = 1) {
  const track = pcm[channel]
  const index = Math.round(time * rate)
  track[index] = sign * 32767
  if (index - 1 >= 0) track[index - 1] = sign * 2600
  if (index + 1 < track.length) track[index + 1] = sign * 2400
  return { channel, start: index, end: index }
}

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

  // 量化到 PCM16 整数刻度后叠加题述访谈险情：
  // 声道 0 有多处削平平顶（含文件边界平顶），声道 1 只有单个满幅瞬态。
  const pcm = tracks.map(track => Array.from(track,
    value => Math.max(-32768, Math.min(32767, Math.round(value * 32768)))))
  const clipLevel = 24576
  const flats = [
    placeFlat(pcm, 0, rate, 0.0, 3, clipLevel, 1),          // 文件起点边界平顶（证据不足）
    placeFlat(pcm, 0, rate, 0.9, 3, clipLevel, 1),          // 圈线会压在其中段
    placeFlat(pcm, 0, rate, 1.45, 6, clipLevel, 1),
    placeFlat(pcm, 0, rate, 1.86, 5, clipLevel, -1),        // 负向削平
    placeFlat(pcm, 0, rate, 2.35, 4, clipLevel, 1),         // 圈线压在中段，仍须认出整段
    placeFlat(pcm, 0, rate, 2.9998125, 3, clipLevel, 1)      // 文件末尾边界平顶
  ]
  const spikes = [
    placeSpike(pcm, 1, rate, 1.1, 1),
    placeSpike(pcm, 1, rate, 1.7, -1),
    placeSpike(pcm, 1, rate, 2.6, 1)
  ]
  const wav = encodePcm16Wav({ pcm, rate }).toString('base64')

  // 刻意把检查时段的两条圈线放在两处可补平顶的中段样点上。
  const circle = { start: 14401 / rate, end: (2.35 * rate + 2) / rate }
  return {
    wav,
    region: { start: 0.63, end: 2.12, low: 1450, high: 1750, db: 26 },
    circle,
    range: circle,
    clipRegion: circle,
    selection: circle,
    clipLevel,
    flats,
    spikes,
    suggestedSelections: ['flat-0-14400-14402', 'flat-0-23200-23205',
      'flat-0-29760-29764', 'flat-0-37600-37603']
  }
}
