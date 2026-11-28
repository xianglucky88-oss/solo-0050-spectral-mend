import { transform } from '../spectrum/transform.mjs'
import { analyzeMono, windowTable, SIZE, HOP } from './analyze.mjs'
import { foldCodes, halfAway } from './pcm.mjs'

export function buildProduct(audio, startFrame, endFrame, checked, stats) {
  const { tracks, rate, frames } = audio
  const [left, right] = tracks
  const length = endFrame - startFrame
  const segL = left.subarray(startFrame, endFrame)
  const segR = right.subarray(startFrame, endFrame)
  const fade = Math.min(Math.round(rate * 0.02), Math.floor(length / 2))
  const envelope = new Float64Array(length)
  let rho = 0, rhoC = 0
  for (let i = 0; i < length; i++) {
    const ramp = x => x >= fade ? 1 : .5 - .5 * Math.cos(Math.PI * x / fade)
    const w = Math.min(ramp(i), ramp(length - 1 - i))
    envelope[i] = w
    rho += w * w
    rhoC += w
  }
  rho /= length
  rhoC /= length
  const gains = new Map()
  for (const b of checked) {
    const pS = stats.pS[b]
    if (pS <= 1e-15) continue
    const A = rho * pS, B = rhoC * stats.cMS[b]
    const root = Math.sqrt(B * B + A * pS)
    gains.set(b, (-B + (B >= 0 ? root : -root)) / A)
  }
  const rescue = new Float64Array(length)
  if (gains.size) {
    const weight = new Float64Array(length)
    const re = new Float64Array(SIZE), im = new Float64Array(SIZE)
    for (let start = HOP - SIZE; start < length; start += HOP) {
      re.fill(0); im.fill(0)
      const first = Math.max(0, -start), last = Math.min(SIZE, length - start)
      for (let i = first; i < last; i++) re[i] = (segL[start + i] - segR[start + i]) / 2 * windowTable[i]
      transform(re, im)
      for (let i = first; i < last; i++) weight[start + i] += windowTable[i] ** 2
      for (const [b, gain] of gains) {
        const { k0, k1 } = stats.bands[b]
        const br = new Float64Array(SIZE), bi = new Float64Array(SIZE)
        for (let k = k0; k <= k1; k++) {
          br[k] = re[k] * gain; bi[k] = im[k] * gain
          if (k > 0 && k < SIZE / 2) { br[SIZE - k] = re[SIZE - k] * gain; bi[SIZE - k] = im[SIZE - k] * gain }
        }
        transform(br, bi, true)
        for (let i = first; i < last; i++) rescue[start + i] += windowTable[i] * br[i]
      }
    }
    for (let i = 0; i < length; i++) if (weight[i] > 0) rescue[i] /= weight[i]
  }
  const fold = foldCodes(left, right)
  const codes = new Int32Array(frames)
  let saturation = 0
  for (let i = 0; i < frames; i++) {
    if (i < startFrame || i >= endFrame) { codes[i] = fold[i]; continue }
    const mid = (left[i] + right[i]) / 2
    const quantized = halfAway((mid + envelope[i - startFrame] * rescue[i - startFrame]) * 32768)
    if (quantized > 32767 || quantized < -32768) saturation++
    codes[i] = Math.max(-32768, Math.min(32767, quantized))
  }
  const product = Float64Array.from(codes, v => v / 32768)
  const measured = analyzeMono(product, rate, startFrame, endFrame)
  const verify = checked.map(b => {
    const target = Math.sqrt((stats.pL[b] + stats.pR[b]) / 2)
    const actual = Math.sqrt(measured.power[b])
    return { index: b, low: stats.bands[b].low, high: stats.bands[b].high,
      target: Math.round(target * 32768 * 10) / 10, actual: Math.round(actual * 32768 * 10) / 10,
      ratio: Math.round(actual / target * 1000) / 1000 }
  })
  return { codes, verify, saturation }
}
