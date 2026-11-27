import { applyTaps, TAPS } from './linalg.mjs'

function rowFor(track, n) {
  const row = new Float64Array(TAPS)
  for (let k = 1; k <= TAPS; k++) row[k - 1] = n - k >= 0 ? track[n - k] : 0
  return row
}

/**
 * 逐帧因果还原两路直达声。
 *
 * 观测模型（每方向固定、延迟 1–8 帧）：
 *   L[n] = sL[n] + (hRL * sR)[n]
 *   R[n] = sR[n] + (hLR * sL)[n]
 * 两个滤波器都没有零延迟抽头，因此 sL[n] 只依赖 sR 的更早帧、sR[n] 只依赖
 * sL 的更早帧，可逐帧求解，无需迭代。
 *
 * 历史从第 0 帧起算，使节目开始处由圈外传进的串漏也一并去掉；输出只在
 * [program.startFrame, program.endFrame) 内取还原值，其余逐样保留观测值。
 */
export function restoreProgram(audio, program, hRL, hLR) {
  const [left, right] = audio.tracks
  const frames = audio.frames
  const sL = new Float64Array(frames)
  const sR = new Float64Array(frames)
  for (let n = 0; n < frames; n++) {
    const fromRight = applyTaps(hRL, rowFor(sR, n))
    const fromLeft = applyTaps(hLR, rowFor(sL, n))
    sL[n] = left[n] - fromRight
    sR[n] = right[n] - fromLeft
  }
  const output = [Float64Array.from(left), Float64Array.from(right)]
  for (let n = program.startFrame; n < program.endFrame; n++) {
    output[0][n] = sL[n]
    output[1][n] = sR[n]
  }
  return output
}

/** 节目内两路还原结果的 PCM16 最大逐样差异（同路同帧比较），并给出位置。 */
export function maxPcmDifference(a, b, program) {
  let amount = 0, atChannel = null, atFrame = null
  for (let channel = 0; channel < a.length; channel++) {
    for (let n = program.startFrame; n < program.endFrame; n++) {
      const qa = Math.max(-32768, Math.min(32767, Math.round(a[channel][n] * 32768)))
      const qb = Math.max(-32768, Math.min(32767, Math.round(b[channel][n] * 32768)))
      const difference = Math.abs(qa - qb)
      if (difference > amount) { amount = difference; atChannel = channel; atFrame = n }
    }
  }
  return { amount, atChannel, atFrame }
}

function peak(track) {
  let value = 0
  for (let i = 0; i < track.length; i++) value = Math.max(value, Math.abs(track[i]))
  return value
}

export function bleedMetrics(before, after, program) {
  return before.map((track, channel) => {
    let delta = 0, peakBefore = 0, peakAfter = 0, saturation = 0
    for (let n = program.startFrame; n < program.endFrame; n++) {
      const output = after[channel][n]
      delta += (track[n] - output) ** 2
      peakBefore = Math.max(peakBefore, Math.abs(track[n]))
      peakAfter = Math.max(peakAfter, Math.abs(output))
      const quantized = Math.round(output * 32768)
      if (quantized < -32768 || quantized > 32767) saturation++
    }
    const length = Math.max(1, program.endFrame - program.startFrame)
    return {
      channel,
      programPeakBefore: peakBefore,
      programPeakAfter: peakAfter,
      removedRms: Math.sqrt(delta / length),
      filePeakBefore: peak(track),
      filePeakAfter: peak(after[channel]),
      saturation
    }
  })
}
