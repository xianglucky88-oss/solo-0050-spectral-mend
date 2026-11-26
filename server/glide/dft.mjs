// 在指定中心时刻、以周期 Hann 窗截取一段信号，计算任意频率（可为小数频格）的复 DFT 系数。
export function localCoefficient(track, center, size, hop, rate, frequency) {
  const start = Math.round(center * rate - size / 2)
  const omega = 2 * Math.PI * frequency / rate
  let real = 0, imaginary = 0
  for (let i = 0; i < size; i++) {
    const sampleIndex = start + i
    if (sampleIndex < 0 || sampleIndex >= track.length) continue
    const windowValue = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size)
    const sample = track[sampleIndex] * windowValue
    const phase = omega * i
    // 正变换 X = Σ x·e^(−iωn)：实部取 cos，虚部取 −sin 的系数。
    real += sample * Math.cos(phase)
    imaginary += -sample * Math.sin(phase)
  }
  // Hann 窗在谐波频格处的相干增益为 N/4，归一化后幅值等于时域振幅。
  return { real: real * 4 / size, imaginary: imaginary * 4 / size }
}

export function magnitude(value) {
  return Math.hypot(value.real, value.imaginary)
}

// 在整数频格谱上寻找最接近目标频率的局部峰，并做抛物线插值，返回峰值频率与幅值。
export function nearestPeak(magnitudes, binHz, targetHz) {
  const center = Math.round(targetHz / binHz)
  const bins = magnitudes.length
  let k = Math.max(1, Math.min(bins - 2, center))
  let guard = 0
  while (guard++ < bins) {
    const left = magnitudes[k - 1], here = magnitudes[k], right = magnitudes[k + 1]
    if (here >= left && here >= right) break
    k = left > right ? k - 1 : k + 1
    if (k <= 1 || k >= bins - 2) break
  }
  const left = magnitudes[k - 1], here = magnitudes[k], right = magnitudes[k + 1]
  const denom = left - 2 * here + right
  const shift = denom === 0 ? 0 : 0.5 * (left - right) / denom
  return { frequency: (k + shift) * binHz, magnitude: here, bin: k }
}
