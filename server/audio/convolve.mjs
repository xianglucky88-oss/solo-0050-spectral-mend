import { transform } from '../spectrum/transform.mjs'
import { quantizeCode } from './quantize.mjs'

// 固定点卷积：x、h 均为 PCM16 整数码。
// 每个输出码 = roundHalfAway( Σ x[a]h[b] / 32768 )，再裁至 PCM16 范围。
// 重放与校样共用本函数，保证同输入逐帧相同。
const DIRECT_PRODUCT_LIMIT = 12_000_000

function nextPowerOfTwo(value) {
  let size = 1
  while (size < value) size *= 2
  return size
}

function convolveDirect(x, h, outputFrames) {
  const output = new Int16Array(outputFrames)
  for (let n = 0; n < outputFrames; n++) {
    let sum = 0
    const first = Math.max(0, n - h.length + 1)
    const last = Math.min(x.length - 1, n)
    for (let a = first; a <= last; a++) sum += x[a] * h[n - a]
    output[n] = quantizeCode(sum / 32768)
  }
  return output
}

function convolveSpectrum(x, h, outputFrames) {
  const size = nextPowerOfTwo(x.length + h.length - 1)
  const realX = new Float64Array(size), imaginaryX = new Float64Array(size)
  const realH = new Float64Array(size), imaginaryH = new Float64Array(size)
  realX.set(x); realH.set(h)
  transform(realX, imaginaryX)
  transform(realH, imaginaryH)
  const real = new Float64Array(size), imaginary = new Float64Array(size)
  for (let k = 0; k < size; k++) {
    real[k] = realX[k] * realH[k] - imaginaryX[k] * imaginaryH[k]
    imaginary[k] = realX[k] * imaginaryH[k] + imaginaryX[k] * realH[k]
  }
  transform(real, imaginary, true)
  const output = new Int16Array(outputFrames)
  for (let n = 0; n < outputFrames; n++) output[n] = quantizeCode(real[n] / 32768)
  return output
}

export function convolve16(x, h, outputFrames) {
  const full = x.length + h.length - 1
  const length = Math.min(outputFrames ?? full, full)
  if (x.length * h.length <= DIRECT_PRODUCT_LIMIT) return convolveDirect(x, h, length)
  return convolveSpectrum(x, h, length)
}
