import { transform } from '../spectrum/transform.mjs'
import { bands } from './bands.mjs'

export const SIZE = 4096
export const HOP = SIZE / 4

export const windowTable = Float64Array.from({ length: SIZE }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / SIZE))
const sumW2 = windowTable.reduce((sum, w) => sum + w * w, 0)
const NORM = 1 / (SIZE * sumW2)

export function bandBins(rate) {
  return bands(rate).map(band => ({
    ...band,
    k0: Math.max(1, Math.ceil(band.low * SIZE / rate - 1e-9)),
    k1: band.high >= rate / 2 ? SIZE / 2 : Math.ceil(band.high * SIZE / rate - 1e-9) - 1
  }))
}

function frameStarts(startFrame, endFrame) {
  const starts = []
  for (let start = startFrame - SIZE / 2; start < endFrame - SIZE / 2; start += HOP) starts.push(start)
  if (!starts.length) starts.push(Math.round((startFrame + endFrame) / 2) - SIZE / 2)
  return starts
}

export function analyzeSegment(left, right, rate, startFrame, endFrame) {
  const list = bandBins(rate)
  const count = list.length
  const pL = new Float64Array(count), pR = new Float64Array(count)
  const pM = new Float64Array(count), pS = new Float64Array(count), cMS = new Float64Array(count)
  const reL = new Float64Array(SIZE), imL = new Float64Array(SIZE)
  const reR = new Float64Array(SIZE), imR = new Float64Array(SIZE)
  let frames = 0
  for (const start of frameStarts(startFrame, endFrame)) {
    reL.fill(0); imL.fill(0); reR.fill(0); imR.fill(0)
    const first = Math.max(0, -start), last = Math.min(SIZE, left.length - start)
    for (let i = first; i < last; i++) {
      reL[i] = left[start + i] * windowTable[i]
      reR[i] = right[start + i] * windowTable[i]
    }
    transform(reL, imL)
    transform(reR, imR)
    frames++
    for (let b = 0; b < count; b++) {
      let sl = 0, sr = 0, sm = 0, ss = 0, sc = 0
      for (let k = list[b].k0; k <= list[b].k1; k++) {
        const c = k === SIZE / 2 ? 1 : 2
        const lr = reL[k], li = imL[k], rr = reR[k], ri = imR[k]
        const mr = (lr + rr) / 2, mi = (li + ri) / 2
        const xr = (lr - rr) / 2, xi = (li - ri) / 2
        sl += c * (lr * lr + li * li)
        sr += c * (rr * rr + ri * ri)
        sm += c * (mr * mr + mi * mi)
        ss += c * (xr * xr + xi * xi)
        sc += c * (mr * xr + mi * xi)
      }
      pL[b] += sl * NORM; pR[b] += sr * NORM; pM[b] += sm * NORM; pS[b] += ss * NORM; cMS[b] += sc * NORM
    }
  }
  for (let b = 0; b < count; b++) {
    pL[b] /= frames; pR[b] /= frames; pM[b] /= frames; pS[b] /= frames; cMS[b] /= frames
  }
  return { bands: list, pL, pR, pM, pS, cMS }
}

export function analyzeMono(track, rate, startFrame, endFrame) {
  const list = bandBins(rate)
  const power = new Float64Array(list.length)
  const re = new Float64Array(SIZE), im = new Float64Array(SIZE)
  let frames = 0
  for (const start of frameStarts(startFrame, endFrame)) {
    re.fill(0); im.fill(0)
    const first = Math.max(0, -start), last = Math.min(SIZE, track.length - start)
    for (let i = first; i < last; i++) re[i] = track[start + i] * windowTable[i]
    transform(re, im)
    frames++
    for (let b = 0; b < list.length; b++) {
      let sum = 0
      for (let k = list[b].k0; k <= list[b].k1; k++) {
        sum += (k === SIZE / 2 ? 1 : 2) * (re[k] ** 2 + im[k] ** 2)
      }
      power[b] += sum * NORM
    }
  }
  for (let b = 0; b < power.length; b++) power[b] /= frames
  return { bands: list, power }
}

export function peaks(audio, columns = 900) {
  const series = []
  for (const track of audio.tracks) {
    const column = []
    for (let c = 0; c < columns; c++) {
      const from = Math.floor(c * audio.frames / columns)
      const to = Math.max(from + 1, Math.floor((c + 1) * audio.frames / columns))
      let mn = Infinity, mx = -Infinity
      for (let i = from; i < to; i++) {
        const value = track[i]
        if (value < mn) mn = value
        if (value > mx) mx = value
      }
      column.push([Math.round(mn * 10000) / 10000, Math.round(mx * 10000) / 10000])
    }
    series.push(column)
  }
  return { left: series[0], right: series[1] }
}
