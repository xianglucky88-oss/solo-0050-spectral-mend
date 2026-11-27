import { quantizeCode } from '../audio/quantize.mjs'

// 时域最小二乘反卷积：在长度 responseFrames 内最小化重放与收音的码域平方误差。
// 卷积矩阵的正规方程 R·h = b 中，R 是探测音自相关构成的对称 Toeplitz 矩阵，
// 用 Levinson–Durbin 在 O(L²) 内求解，避免频域除法在弱频格上的条件数放大。
//
// 收音段已是量化后的 PCM16 码（固定点卷积量化时除以 32768），
// 故解出的浮点响应处于「码 / 32768」尺度，量化回码前先乘满幅倍率。
export function deconvolve(probe, segment, responseFrames) {
  const length = responseFrames
  const autocorrelation = new Float64Array(length)
  for (let lag = 0; lag < length; lag++) {
    let sum = 0
    const limit = probe.length - lag
    for (let i = 0; i < limit; i++) sum += probe[i] * probe[i + lag]
    autocorrelation[lag] = sum
  }
  const crossCorrelation = new Float64Array(length)
  for (let lag = 0; lag < length; lag++) {
    let sum = 0
    const limit = Math.min(probe.length, segment.length - lag)
    for (let i = 0; i < limit; i++) sum += probe[i] * segment[i + lag]
    crossCorrelation[lag] = sum
  }
  const solution = solveToeplitz(autocorrelation, crossCorrelation)
  const response = new Int16Array(length)
  for (let i = 0; i < length; i++) response[i] = quantizeCode(solution[i] * 32768)
  return response
}

// 标准 Levinson–Durbin：解对称正定 Toeplitz 系统 R·x = b。
function solveToeplitz(r, b) {
  const n = r.length
  const x = new Float64Array(n)
  let predictor = new Float64Array(1)
  predictor[0] = 1
  let predictionError = r[0]
  x[0] = b[0] / r[0]
  for (let order = 1; order < n; order++) {
    let reflectionNumerator = r[order]
    for (let j = 1; j < order; j++) reflectionNumerator += r[j] * predictor[order - j]
    const reflection = -reflectionNumerator / predictionError
    const nextPredictor = new Float64Array(order + 1)
    nextPredictor[0] = 1
    for (let j = 1; j < order; j++) {
      nextPredictor[j] = predictor[j] + reflection * predictor[order - j]
    }
    nextPredictor[order] = reflection
    predictionError += reflection * reflectionNumerator
    let residual = b[order]
    for (let j = 0; j < order; j++) residual -= r[order - j] * x[j]
    const mu = residual / predictionError
    const nextX = new Float64Array(order + 1)
    for (let j = 0; j < order; j++) nextX[j] = x[j] + mu * nextPredictor[order - j]
    nextX[order] = mu
    predictor = nextPredictor
    for (let j = 0; j <= order; j++) x[j] = nextX[j]
  }
  return x
}
