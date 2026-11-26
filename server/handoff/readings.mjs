import { InputError } from '../http/error.mjs'
import { solveSystem } from './fit.mjs'

// 核听段以帧号描述，首帧（全局 n=0）为所有正余弦的相位零点。
export function resolveSegment(segment, frames) {
  if (!segment || typeof segment !== 'object') throw new InputError('每项需要指定核听段。')
  const first = Math.trunc(segment.first ?? segment.start)
  const last = Math.trunc(segment.last ?? segment.end)
  if (!Number.isInteger(first) || !Number.isInteger(last) || first < 0 || last < first || last >= frames) {
    throw new InputError('核听段帧号需要落在录音范围内且首尾有序。')
  }
  return { first, last }
}

// 同一核听段内与直流一并拟合的频点；0 Hz 单独按带符号平均码值读取。
export function resolveFrequencies(frequencies, rate) {
  if (!Array.isArray(frequencies) || frequencies.length === 0) throw new InputError('每项至少需要一个带内量测频点。')
  const seen = new Set()
  const result = []
  for (const value of frequencies) {
    if (!Number.isFinite(value) || value <= 0 || value >= rate / 2) {
      throw new InputError('量测频点应为录音带内的正频率且低于奈奎斯特频率。')
    }
    if (seen.has(value)) throw new InputError('同一核听段内频点不得重复。')
    seen.add(value)
    result.push(value)
  }
  return result
}

// 单声道、单核听段读数。0 Hz 为带符号平均码值；其余频点与直流共同做
// 最小均方误差正余弦拟合。unique=false 表示拟合秩亏，读数不唯一，不得核准。
export function readChannel(codes, channel, rate, segment, frequencies) {
  const { first, last } = segment
  const count = last - first + 1
  const observations = Float64Array.from({ length: count }, (_, index) => codes[channel][first + index])
  let sum = 0
  for (const value of observations) sum += value
  const direct = sum / count
  const columns = [Float64Array.from({ length: count }, () => 1)]
  for (const hz of frequencies) {
    const omega = 2 * Math.PI * hz / rate
    columns.push(Float64Array.from({ length: count }, (_, index) => Math.cos(omega * (first + index))))
    columns.push(Float64Array.from({ length: count }, (_, index) => Math.sin(omega * (first + index))))
  }
  const answer = solveSystem(columns, observations)
  const readings = [{ frequency: 0, cosine: direct, sine: 0 }]
  if (!answer) return { unique: false, readings }
  for (const [index, hz] of frequencies.entries()) {
    readings.push({ frequency: hz, cosine: answer[1 + 2 * index], sine: answer[2 + 2 * index] })
  }
  return { unique: true, readings }
}

export function readAll(codes, rate, segment, frequencies) {
  return codes.map((_, channel) => readChannel(codes, channel, rate, segment, frequencies))
}

// 两组读数是否逐系数相差不超过 2 码（0 Hz 仅比直流，其余比正余弦）。
// 容差含机器精度 epsilon，避免 2.0000000000000004 这类表示误差误判。
export function withinTolerance(expected, actual) {
  if (expected.length !== actual.length) return false
  const tolerance = 2 + Number.EPSILON * 100
  return expected.every((reading, index) => {
    const other = actual[index]
    if (reading.frequency !== other.frequency) return false
    if (reading.frequency === 0) return Math.abs(reading.cosine - other.cosine) <= tolerance
    return Math.abs(reading.cosine - other.cosine) <= tolerance &&
      Math.abs(reading.sine - other.sine) <= tolerance
  })
}
