// 两段校准共用的仿射映射。
// 主录音帧 n（主采样率 Fx）映射到参考帧 m（参考采样率 Fr）：
//   m = rho * n + delta
// 等价物理时间关系 t_ref = k * t_main + offsetSeconds，其中
//   k = rho * Fx / Fr，offsetSeconds = delta / Fr。

export function calibrationFromLags({ n1, n2, lag1, lag2, mainRate, referenceRate }) {
  const ratio = referenceRate / mainRate
  if (Math.abs(n2 - n1) < 1) {
    return { rho: ratio, delta: ratio * lag1, n1, n2, lag1, lag2: lag1 }
  }
  const slope = (lag2 - lag1) / (n2 - n1) // 主坐标滞后随帧的斜率
  const rho = ratio * (1 + slope)
  const delta = ratio * (lag1 - slope * n1)
  return { rho, delta, n1, n2, lag1, lag2 }
}

export function lagsFromRhoDelta({ rho, delta, n1, n2, mainRate, referenceRate }) {
  const ratio = referenceRate / mainRate
  const slope = rho / ratio - 1
  return { lag1: slope * n1 + delta / ratio, lag2: slope * n2 + delta / ratio }
}

export function describeCalibration(cal, mainRate, referenceRate) {
  const k = cal.rho * mainRate / referenceRate
  return {
    rho: cal.rho,
    deltaSamples: cal.delta,
    offsetSeconds: cal.delta / referenceRate,
    rateRatio: k,
    rateDifference: k - 1,
    ppm: (k - 1) * 1e6,
    mainRate,
    referenceRate
  }
}

// 参考覆盖对应的主录音时间区间（秒）。kernelMargin 为插值核所需参考采样余量。
export function coverageInterval({ rho, delta }, mainFrames, referenceFrames, mainRate, kernelMargin = 0) {
  if (!(rho > 0)) return null
  const lo = (kernelMargin - delta) / rho
  const hi = (referenceFrames - 1 - kernelMargin - delta) / rho
  const startFrame = Math.max(0, lo)
  const endFrame = Math.min(mainFrames, hi + 1)
  if (endFrame <= startFrame) return null
  return { start: startFrame / mainRate, end: endFrame / mainRate,
    startFrame, endFrame }
}
