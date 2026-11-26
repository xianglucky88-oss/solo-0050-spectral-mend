import { localCoefficient, magnitude } from './dft.mjs'

const FADE_SECONDS = 0.02

function unwrap(phases) {
  const result = [phases[0]]
  for (let i = 1; i < phases.length; i++) {
    let delta = phases[i] - phases[i - 1]
    while (delta > Math.PI) delta -= 2 * Math.PI
    while (delta < -Math.PI) delta += 2 * Math.PI
    result.push(result[i - 1] + delta)
  }
  return result
}

// 线性插值；端点之外按首尾斜率外推一小段，保证边界处相位连续。
function makeInterpolation(times, values) {
  return function at(time) {
    if (time <= times[0]) {
      if (times.length < 2) return values[0]
      const slope = (values[1] - values[0]) / (times[1] - times[0])
      return values[0] + slope * (time - times[0])
    }
    if (time >= times[times.length - 1]) {
      const n = times.length
      if (n < 2) return values[n - 1]
      const slope = (values[n - 1] - values[n - 2]) / (times[n - 1] - times[n - 2])
      return values[n - 1] + slope * (time - times[n - 1])
    }
    let i = 0
    while (time > times[i + 1]) i++
    const p = (time - times[i]) / (times[i + 1] - times[i])
    return values[i] + (values[i + 1] - values[i]) * p
  }
}

function makeClampInterpolation(times, values) {
  const linear = makeInterpolation(times, values)
  return function at(time) {
    if (time <= times[0]) return values[0]
    if (time >= times[times.length - 1]) return values[times.length - 1]
    return linear(time)
  }
}

// 每个声道、每一阶提取随时间变化的幅度与解卷绕相位，再构造旧平音与新滑音。
function harmonicTracks(track, analysis, params) {
  const { rate } = params
  return analysis.harmonics.map(harmonic => {
    const complex = analysis.centers.map((center, index) => {
      const coefficient = localCoefficient(track, center, analysis.plan.size, analysis.plan.hop, rate, harmonic.carrier)
      // DFT 相位相对窗起点：相对相位 = 绝对相位 − ωn₀，减去 ωn₀ 换到绝对时间轴。
      const startSample = Math.round(center * rate - analysis.plan.size / 2)
      const correction = 2 * Math.PI * harmonic.carrier * (startSample / rate)
      return { real: coefficient.real * Math.cos(correction) + coefficient.imaginary * Math.sin(correction),
        imaginary: coefficient.imaginary * Math.cos(correction) - coefficient.real * Math.sin(correction) }
    })
    const magnitudes = complex.map(magnitude)
    const phases = unwrap(complex.map(value => Math.atan2(value.imaginary, value.real)))
    return {
      order: harmonic.order,
      carrier: harmonic.carrier,
      amplitude: makeClampInterpolation(analysis.centers, magnitudes),
      phase: makeInterpolation(analysis.centers, phases),
    }
  })
}

export function synthesize(audio, params, analysis) {
  const { rate, frames } = audio
  const tracks = audio.tracks.map(original => Float64Array.from(original))
  const first = Math.round(params.start * rate)
  const last = Math.round(params.end * rate)
  const fade = Math.max(1, Math.round(FADE_SECONDS * rate))
  const span = last - first
  const duration = span / rate
  const perChannel = audio.tracks.map(track => harmonicTracks(track, analysis, { ...params, rate }))

  perChannel.forEach((voices, channel) => {
    const output = tracks[channel]
    const original = audio.tracks[channel]
    for (let i = first; i < last; i++) {
      const t = i / rate
      let weight = 1
      if (i - first < fade) weight = 0.5 - 0.5 * Math.cos(Math.PI * (i - first) / fade)
      else if (last - i < fade) weight = 0.5 - 0.5 * Math.cos(Math.PI * (last - i) / fade)
      let oldTone = 0, newTone = 0
      for (const voice of voices) {
        const amplitude = voice.amplitude(t)
        oldTone += amplitude * Math.cos(voice.phase(t))
        const phi0 = voice.phase(params.start)
        const elapsed = t - params.start
        // 匀速上滑：相位是瞬时频率 order·f(t) 的积分，f(t) 在 targetStart 与 targetEnd 间线性变化。
        const sweptPhase = phi0 + 2 * Math.PI * voice.order *
          (params.targetStart * elapsed + 0.5 * (params.targetEnd - params.targetStart) / duration * elapsed * elapsed)
        newTone += amplitude * Math.cos(sweptPhase)
      }
      output[i] = original[i] + weight * (newTone - oldTone)
    }
  })
  return { ...audio, tracks, editedWindows: analysis.centers.length, segmentFrames: span }
}
