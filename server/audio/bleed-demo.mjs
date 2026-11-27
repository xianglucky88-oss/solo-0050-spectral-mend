import { encode } from './encode.mjs'

/**
 * 内置串漏示例。左、右两路各有三段独奏（互不重叠、另一路独奏时保持安静），
 * 另有一段与校准分开的待修节目。两路之间存在固定、延迟 1–8 帧的串漏，
 * 单位脉冲串入绝对值之和均小于原幅值的一半；串漏含有负抽头（可多峰、可反相）。
 * 节目段两路同处 300 赫兹附近，用来检验同频时能否还原各自时间、幅度与相位。
 */
export function bleedDemo() {
  const rate = 16000
  const frames = rate * 4 // 4 秒
  const hLR = [0.18, -0.09, 0.05, 0.02, 0, -0.03, 0.01, 0.02] // 左→右
  const hRL = [0.12, 0.06, 0, -0.04, 0.03, 0, 0.01, -0.02]     // 右→左

  const leftSolo = [[rate * 0.2, rate * 0.5], [rate * 0.75, rate * 1.0], [rate * 1.15, rate * 1.45]]
  const rightSolo = [[rate * 1.6, rate * 1.9], [rate * 2.05, rate * 2.35], [rate * 2.5, rate * 2.8]]
  const program = [rate * 2.95, rate * 3.85]

  const srcL = new Float64Array(frames)
  const srcR = new Float64Array(frames)
  const leftContent = n => 0.26 * Math.sin(2 * Math.PI * 300 * n / rate) + 0.12 * Math.sin(2 * Math.PI * 510 * n / rate + 0.4)
  const rightContent = n => 0.24 * Math.sin(2 * Math.PI * 420 * n / rate + 1.2) + 0.10 * Math.sin(2 * Math.PI * 700 * n / rate)

  for (const [a, b] of leftSolo) for (let n = Math.round(a); n < Math.round(b); n++) srcL[n] = leftContent(n)
  for (const [a, b] of rightSolo) for (let n = Math.round(a); n < Math.round(b); n++) srcR[n] = rightContent(n)
  // 节目：两路各自成乐句，且在 300 赫兹处重合（同频），但时间、幅度、相位不同。
  for (let n = Math.round(program[0]); n < Math.round(program[1]); n++) {
    const t = (n - program[0]) / rate
    const envelope = Math.min(1, t * 20, (program[1] - n) / rate * 20)
    srcL[n] = envelope * (0.20 * Math.sin(2 * Math.PI * 300 * n / rate + 0.2)
      + 0.10 * Math.sin(2 * Math.PI * 450 * n / rate + 0.9))
    srcR[n] = envelope * (0.18 * Math.sin(2 * Math.PI * 300 * n / rate + 2.4)
      + 0.09 * Math.sin(2 * Math.PI * 620 * n / rate + 0.3))
  }

  const left = new Float64Array(frames)
  const right = new Float64Array(frames)
  const bleed = (history, n, taps) => {
    let sum = 0
    for (let k = 1; k <= taps.length; k++) if (n - k >= 0) sum += taps[k - 1] * history[n - k]
    return sum
  }
  for (let n = 0; n < frames; n++) {
    left[n] = srcL[n] + bleed(srcR, n, hRL)
    right[n] = srcR[n] + bleed(srcL, n, hLR)
  }

  const toSeconds = framesList => framesList.map(([a, b]) => ({ start: a / rate, end: b / rate }))
  return {
    wav: encode({ tracks: [left, right], rate, frames }).toString('base64'),
    calibration: {
      solos: [toSeconds(leftSolo), toSeconds(rightSolo)],
      program: { start: program[0] / rate, end: program[1] / rate }
    }
  }
}
