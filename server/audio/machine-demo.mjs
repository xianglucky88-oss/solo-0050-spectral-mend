import { encode } from './encode.mjs'
import { sampleAt } from '../machine/interpolate.mjs'

// 确定性 PRNG（32 位整数乘法，避免大整数精度问题）。
export function mulberry32(seed) {
  let a = seed >>> 0
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function linearAt(buffer, pos) {
  if (pos <= 0) return buffer[0]
  if (pos >= buffer.length - 1) return buffer[buffer.length - 1]
  const i = Math.floor(pos), f = pos - i
  return buffer[i] * (1 - f) + buffer[i + 1] * f
}

// 生成“同一台机器”的主录音（可双声道、带说话声）与单声道参考。
// options 可注入已知仿射参数，便于自检与构造边界情形。
export function makeMachinePair(options = {}) {
  const mainRate = options.mainRate ?? 16000
  const referenceRate = options.referenceRate ?? 22050
  const mainSeconds = options.mainSeconds ?? 5
  const mainFrames = Math.round(mainRate * mainSeconds)
  const rho = options.rho ?? (referenceRate / mainRate) * 1.0015
  const delta = options.delta ?? 7700
  const gains = options.gains ?? [0.34, -0.22]
  const channels = options.channels ?? 2
  const seed = options.seed ?? 20261127
  const rng = mulberry32(seed)

  // 参考长度：默认覆盖到主录音 4.95 秒。
  const referenceFrames = options.referenceFrames ??
    Math.ceil(delta + rho * Math.round(mainRate * 4.95)) + 64

  // 响动时刻（参考物理秒）：不规则间隔，保证对应关系唯一。
  const clunkTimes = []
  {
    let t = 0.18
    const gaps = [0.31, 0.47, 0.38, 0.53, 0.29, 0.61, 0.42, 0.36, 0.58, 0.33, 0.49, 0.44, 0.55]
    let gi = 0
    while (t < referenceFrames / referenceRate - 0.1) {
      clunkTimes.push(t)
      t += gaps[gi % gaps.length]
      gi++
    }
  }

  const noise = new Float64Array(referenceFrames)
  let low = 0
  for (let i = 0; i < referenceFrames; i++) {
    const white = rng() * 2 - 1
    low = low * 0.82 + white * 0.18
    noise[i] = low * 0.5 + white * 0.12
  }

  const reference = new Float64Array(referenceFrames)
  for (let m = 0; m < referenceFrames; m++) {
    const t = m / referenceRate
    // 电机谐波嗡声（含与“说话”同频的 120 Hz 分量）。
    let v = 0
    v += 0.20 * Math.sin(2 * Math.PI * 60 * t + 0.4 * Math.sin(2 * Math.PI * 5 * t))
    v += 0.12 * Math.sin(2 * Math.PI * 120 * t + 0.7)
    v += 0.06 * Math.sin(2 * Math.PI * 180 * t + 1.9)
    v += 0.045 * Math.sin(2 * Math.PI * 1600 * t + 0.3)
    // 机器嘶声。
    v += 0.05 * noise[m]
    // 响动：低频“咚”加宽带衰减爆裂。
    for (const ct of clunkTimes) {
      const dt = t - ct
      if (dt >= 0 && dt < 0.12) {
        const env = Math.exp(-dt / 0.022)
        v += 0.5 * env * Math.sin(2 * Math.PI * 118 * dt)
        v += 0.22 * Math.exp(-dt / 0.006) * (noise[Math.min(referenceFrames - 1, Math.round(ct * referenceRate) + Math.round(dt * referenceRate))] ?? 0)
      }
    }
    reference[m] = v * 0.8
  }

  // 主录音中的机器声：刻意用线性插值经同一仿射映射得到，
  // 与产品使用的高质量 sinc 不同，以验证校准的容差。
  const machine = Array.from({ length: channels }, () => new Float64Array(mainFrames))
  for (let n = 0; n < mainFrames; n++) {
    const pos = rho * n + delta
    if (pos < 0 || pos > referenceFrames - 1) continue
    const sample = options.sincMain ? sampleAt(reference, pos) : linearAt(reference, pos)
    for (let c = 0; c < channels; c++) machine[c][n] = gains[c] * sample
  }

  // 说话声（只在修复区出现）：带音节包络与颤音的谐波簇，
  // 特意包含 120 Hz 附近与机器同频的能量，检验“保留同频说话”。
  const voice = Array.from({ length: channels }, () => new Float64Array(mainFrames))
  const speakStart = options.speakStart ?? 1.15
  const speakEnd = options.speakEnd ?? 3.95
  for (let n = 0; n < mainFrames; n++) {
    const t = n / mainRate
    if (t < speakStart || t > speakEnd) continue
    const inPos = Math.min(1, (t - speakStart) / 0.04)
    const outPos = Math.min(1, (speakEnd - t) / 0.05)
    const edge = Math.min(inPos, outPos)
    // 3.2–3.55 秒留一个句中停顿，作为纯机器“稳段”。
    let syllable = 0.55 + 0.45 * Math.max(0, Math.sin(2 * Math.PI * 2.7 * t))
    if (t > 3.18 && t < 3.58) syllable *= Math.max(0, 1 - Math.min((t - 3.18) / 0.05, (3.58 - t) / 0.05, 1))
    const env = edge * syllable
    const f0 = 132 * (1 + 0.012 * Math.sin(2 * Math.PI * 4.3 * t))
    let s = 0.16 * Math.sin(2 * Math.PI * f0 * t)
    s += 0.10 * Math.sin(2 * Math.PI * 2 * f0 * t + 0.4)
    s += 0.05 * Math.sin(2 * Math.PI * 3 * f0 * t + 1.1)
    s += 0.05 * Math.sin(2 * Math.PI * 120 * t + 2.2) // 与机器 120Hz 同频
    for (let c = 0; c < channels; c++) {
      const pan = c === 0 ? 1 : 0.82
      voice[c][n] = s * env * pan
    }
  }

  const tracks = machine.map((track, c) => {
    const out = new Float64Array(mainFrames)
    const noiseFloor = options.noiseFloor ?? 0
    for (let n = 0; n < mainFrames; n++) {
      const add = noiseFloor ? (mulberry32(seed + c * 7919 + n)() - 0.5) * 2 * noiseFloor : 0
      out[n] = Math.max(-1, Math.min(1, track[n] + voice[c][n] + add))
    }
    return out
  })

  const first = options.first ?? { start: 0.25, end: 1.05 }
  const second = options.second ?? { start: 4.02, end: 4.82 }
  const repairs = options.repairs ?? [{ start: 1.15, end: 3.95 }]
  const stable = options.stable ?? { start: 3.24, end: 3.52 }

  const main = { tracks, rate: mainRate, frames: mainFrames }
  const refAudio = { tracks: [reference], rate: referenceRate, frames: referenceFrames }
  return {
    main, reference: refAudio, machine, voice,
    mainWav: encode(main).toString('base64'),
    referenceWav: encode(refAudio).toString('base64'),
    truth: { rho, delta, gains, k: rho * mainRate / referenceRate },
    first, second, repairs, stable,
    clunkTimes
  }
}

// 工作台“打开两件”的内置示范。
export function machineDemo() {
  const pair = makeMachinePair()
  return {
    mainWav: pair.mainWav,
    referenceWav: pair.referenceWav,
    first: pair.first,
    second: pair.second,
    repairs: pair.repairs,
    stable: pair.stable,
    reference: { rate: pair.reference.rate, frames: pair.reference.frames },
    truth: pair.truth
  }
}
