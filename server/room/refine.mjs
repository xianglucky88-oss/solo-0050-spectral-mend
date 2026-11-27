import { quantizeCode } from '../audio/quantize.mjs'

// 整数坐标下降后处理。
// 最小二乘给出最优浮点响应，但量化为整数码后逐帧差仍可能越过 2 码。
// 这里直接以「重放码与收音码的逐帧差」为目标，在整数码网格上逐坐标微调，
// 维护未量化的卷积和 S，改动单个响应码时只增量更新受影响的输出帧。
const MAX_PASSES = 8
const VIOLATION_WEIGHT = 100_000

function penalty(difference) {
  // 越过 2 码的差异给予大权重，优先消灭违规；其余以平方误差收敛。
  return difference > 2 ? VIOLATION_WEIGHT + difference * difference : difference * difference
}

export function refineResponse(probe, segment, initial) {
  const response = Int16Array.from(initial)
  const outputFrames = segment.length
  const responseFrames = response.length
  const sums = new Float64Array(outputFrames)
  for (let t = 0; t < outputFrames; t++) {
    const first = Math.max(0, t - responseFrames + 1)
    const last = Math.min(probe.length - 1, t)
    let sum = 0
    for (let a = first; a <= last; a++) sum += probe[a] * response[t - a]
    sums[t] = sum
  }
  const framePenalty = t => penalty(Math.abs(quantizeCode(sums[t] / 32768) - segment[t]))
  let totalPenalty = 0
  for (let t = 0; t < outputFrames; t++) totalPenalty += framePenalty(t)

  for (let pass = 0; pass < MAX_PASSES; pass++) {
    let moved = false
    for (let j = 0; j < responseFrames; j++) {
      let bestDelta = 0
      let bestPenalty = totalPenalty
      for (const delta of [-1, 1]) {
        const candidate = response[j] + delta
        if (candidate < -32768 || candidate > 32767) continue
        const lastT = Math.min(outputFrames - 1, j + probe.length - 1)
        let candidatePenalty = totalPenalty
        for (let t = j; t <= lastT; t++) {
          candidatePenalty -= framePenalty(t)
          candidatePenalty += penalty(Math.abs(
            quantizeCode((sums[t] + delta * probe[t - j]) / 32768) - segment[t]))
        }
        if (candidatePenalty < bestPenalty) {
          bestPenalty = candidatePenalty
          bestDelta = delta
        }
      }
      if (bestDelta !== 0) {
        const lastT = Math.min(outputFrames - 1, j + probe.length - 1)
        for (let t = j; t <= lastT; t++) sums[t] += bestDelta * probe[t - j]
        response[j] += bestDelta
        totalPenalty = bestPenalty
        moved = true
      }
    }
    if (!moved) break
  }
  return response
}
