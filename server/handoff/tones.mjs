import { solveSystem } from './fit.mjs'
import { readAll } from './readings.mjs'

function fittingColumns(rate, segment, frequencies) {
  const { first, last } = segment
  const columns = [Float64Array.from({ length: last - first + 1 }, () => 1)]
  for (const hz of frequencies) {
    const omega = 2 * Math.PI * hz / rate
    columns.push(Float64Array.from({ length: last - first + 1 }, (_, index) => Math.cos(omega * (first + index))))
    columns.push(Float64Array.from({ length: last - first + 1 }, (_, index) => Math.sin(omega * (first + index))))
  }
  return columns
}

// 声线 = 保留频点上的正余弦（含直流）成分。系数在核听段内拟合，
// 相位零点仍是全局首帧；任一声道无法分辨（秩亏）即返回 null。
export function estimateTones(codes, rate, segment, retained) {
  const columns = fittingColumns(rate, segment, retained)
  const coefficients = []
  for (const channel of codes) {
    const observations = Float64Array.from({ length: segment.last - segment.first + 1 },
      (_, index) => channel[segment.first + index])
    const answer = solveSystem(columns, observations)
    if (!answer) return null
    const channelCoefficients = [{ frequency: 0, cosine: answer[0], sine: 0 }]
    for (const [index, hz] of retained.entries()) {
      channelCoefficients.push({ frequency: hz, cosine: answer[1 + 2 * index], sine: answer[2 + 2 * index] })
    }
    coefficients.push(channelCoefficients)
  }
  return coefficients
}

function toneAt(coefficients, rate, index) {
  let value = 0
  for (const { frequency, cosine, sine } of coefficients) {
    if (frequency === 0) value += cosine
    else {
      const omega = 2 * Math.PI * frequency / rate * index
      value += cosine * Math.cos(omega) + sine * Math.sin(omega)
    }
  }
  return value
}

// 按同一系数在整段录音上重建每条声线（浮点码值域）。
export function renderTones(coefficients, rate, frames) {
  return coefficients.map(channel =>
    Float64Array.from({ length: frames }, (_, index) => toneAt(channel, rate, index)))
}

// 扣除声线后的残差码值（保持整数 PCM 域，四舍五入并饱和）。
export function stripTones(codes, toneTracks) {
  return codes.map((channel, c) => Int16Array.from(channel, (value, index) =>
    Math.max(-32768, Math.min(32767, Math.round(value - toneTracks[c][index])))))
}

// 把声线加回到残差上（重做时保留带外声线）。
export function addTones(residualCodes, toneTracks) {
  return residualCodes.map((channel, c) => Int16Array.from(channel, (value, index) =>
    Math.max(-32768, Math.min(32767, Math.round(value + toneTracks[c][index])))))
}

// 声线本身在核听段上的成品读数：先按系数重建并量化成码值，再走与普通读数
// 完全相同的最小二乘拟合，保证「成品读数各差不超 2 码」口径一致。
export function toneReadings(toneTracks, rate, segment, retained) {
  const codes = toneTracks.map(track => Int16Array.from(track, value =>
    Math.max(-32768, Math.min(32767, Math.round(value)))))
  return readAll(codes, rate, segment, retained).map(result => result.readings)
}
