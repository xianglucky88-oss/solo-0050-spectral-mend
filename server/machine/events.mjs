import { transform } from '../spectrum/transform.mjs'
import { makeKernel, tableAt } from './interpolate.mjs'

const kernel = makeKernel(8, 8.6)

// 频谱通量响动检测：稳态音调不产生逐帧正向通量，宽带突起会产生。
export function detectEvents(track, rate, startFrame = 0, endFrame = track.length, options = {}) {
  const from = Math.max(0, Math.floor(startFrame))
  const to = Math.min(track.length, Math.floor(endFrame))
  const size = 256
  const hop = 64
  if (to - from < size * 2) return []
  const window = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / size))
  const fluxes = []
  let previous = null
  for (let p = from; p + size <= to; p += hop) {
    const real = new Float64Array(size), imag = new Float64Array(size)
    for (let i = 0; i < size; i++) real[i] = track[p + i] * window[i]
    transform(real, imag, false)
    let flux = 0
    const mags = new Float64Array(size / 2 + 1)
    for (let k = 0; k < mags.length; k++) {
      mags[k] = Math.hypot(real[k], imag[k])
      if (previous) flux += Math.max(0, mags[k] - previous[k])
    }
    fluxes.push({ p: p + size / 2, flux })
    previous = mags
  }
  if (fluxes.length < 5) return []
  const sorted = fluxes.map(f => f.flux).sort((a, b) => a - b)
  const median = sorted[Math.floor(sorted.length / 2)] || 0
  const threshold = Math.max(median * 2.4, 1e-4 * size)
  const minSpacing = Math.round((options.minSpacingSeconds ?? 0.05) * rate / hop)
  const peaks = []
  for (let i = 1; i < fluxes.length - 1; i++) {
    const cur = fluxes[i]
    if (cur.flux < threshold || cur.flux < fluxes[i - 1].flux || cur.flux < fluxes[i + 1].flux) continue
    if (peaks.length && i - peaks[peaks.length - 1].frameIndex < minSpacing) {
      if (cur.flux > peaks[peaks.length - 1].flux) peaks[peaks.length - 1] = { frameIndex: i, ...cur }
    } else peaks.push({ frameIndex: i, ...cur })
  }
  // 精化到采样：在帧中心附近找最大 |一阶差分|。
  return peaks.map(peak => {
    const center = Math.round(peak.p)
    let best = center, bestV = -1
    for (let s = center - hop; s <= center + hop; s++) {
      if (s <= 0 || s >= track.length) continue
      const v = Math.abs(track[s] - track[s - 1])
      if (v > bestV) { bestV = v; best = s }
    }
    return { frame: best, time: best / rate, strength: peak.flux }
  })
}

function mergeEvents(lists, rate, mergeMs = 4) {
  const all = lists.flat().sort((a, b) => a.frame - b.frame)
  const merged = []
  for (const event of all) {
    const last = merged[merged.length - 1]
    if (last && Math.abs(event.frame - last.frame) <= mergeMs / 1000 * rate) {
      if (event.strength > last.strength) Object.assign(last, event)
    } else merged.push({ ...event })
  }
  return merged
}

// 局部块互相关：直接量度“同一次响动”在全局映射后的残余偏差（采样/毫秒）。
function localLagCheck(channels, rate, reference, cal, ranges) {
  const block = Math.round(0.05 * rate)
  const hop = block / 2
  const search = Math.round(0.0025 * rate)
  const results = []
  for (const [a, b] of ranges) {
    let c = 0, bestRms = -1
    channels.forEach((t, i) => {
      let e = 0
      for (let n = a; n < b; n++) e += t[n] * t[n]
      if (e > bestRms) { bestRms = e; c = i }
    })
    const track = channels[c]
    for (let start = a; start + block <= b; start += hop) {
      const x = track.subarray(start, start + block)
      const ex = x.reduce((s, v) => s + v * v, 0)
      if (ex / block < (8 / 32768) ** 2) continue
      const scores = []
      for (let shift = -search; shift <= search; shift++) {
        let cross = 0, ez = 0, valid = true
        for (let i = 0; i < block; i++) {
          const n = start + i + shift
          const pos = cal.rho * n + cal.delta
          if (pos < kernel.lobes || pos > reference.length - 1 - kernel.lobes) { valid = false; break }
          const z = tableAt(kernel, reference, pos)
          cross += x[i] * z
          ez += z * z
        }
        if (!valid || ez <= 1e-18) continue
        const ncc = cross / Math.sqrt(ex * ez)
        scores.push({ shift, ncc })
      }
      if (!scores.length) continue
      const strongest = Math.max(...scores.map(o => Math.abs(o.ncc)))
      if (strongest < 0.85) continue
      // 周期信号会有多个等高峰；在几乎同强的峰中选最接近零的，
      // 因为这里量度的是相对已拟合全局映射的残余偏差。
      const tied = scores.filter(o => Math.abs(o.ncc) >= strongest - 0.015)
      const best = tied.reduce((a, b) => Math.abs(b.shift) < Math.abs(a.shift) ? b : a)
      // 亚采样抛物线修正。
      const around = s => scores.find(o => o.shift === s)?.ncc
      const y0 = around(best.shift), ym = around(best.shift - 1), yp = around(best.shift + 1)
      let fine = best.shift
      if (Number.isFinite(ym) && Number.isFinite(yp)) {
        const denom = ym - 2 * y0 + yp
        if (denom !== 0) fine += Math.max(-1, Math.min(1, 0.5 * (ym - yp) / denom))
      }
      // 远处存在几乎同样强的另一峰：局部对应不唯一（记录用）。
      const rival = scores.find(o => Math.abs(o.shift - best.shift) > 0.00075 * rate &&
        Math.abs(o.ncc) > strongest - 0.01)
      results.push({ ms: fine / rate * 1000, ncc: strongest, ambiguousLocal: Boolean(rival) })
    }
  }
  return results
}

// 事件对齐综合结论。ranges 为帧区间数组。
export function eventAlignment(mainTracks, mainRate, reference, cal, ranges) {
  const local = localLagCheck(mainTracks, mainRate, reference, cal, ranges)
  const confident = local.filter(r => r.ncc >= 0.9)
  const maxLocalMs = confident.length ? Math.max(...confident.map(r => Math.abs(r.ms))) : 0
  const localAmbiguous = confident.some(r => r.ambiguousLocal)

  const margin = Math.round(0.05 * mainRate)
  const mainEvents = mergeEvents(
    mainTracks.map(track => ranges.flatMap(([a, b]) => detectEvents(track, mainRate, a, b))),
    mainRate
  )
  const refEvents = []
  for (const [a, b] of ranges) {
    const lo = Math.max(0, a - margin), hi = Math.min(mainTracks[0].length, b + margin)
    const z = new Float64Array(hi - lo)
    for (let n = lo; n < hi; n++) z[n - lo] = tableAt(kernel, reference, cal.rho * n + cal.delta)
    refEvents.push(...detectEvents(z, mainRate, 0, z.length).map(e => ({ frame: e.frame + lo })))
  }
  const refMerged = mergeEvents([refEvents], mainRate)
  const matchFrames = 0.0025 * mainRate
  const pairs = []
  for (const event of mainEvents) {
    let nearest = null, second = null
    for (const refEvent of refMerged) {
      const diff = refEvent.frame - event.frame
      if (!nearest || Math.abs(diff) < Math.abs(nearest.diff)) { second = nearest; nearest = { diff } }
      else if (!second || Math.abs(diff) < Math.abs(second.diff)) second = { diff }
    }
    if (nearest && Math.abs(nearest.diff) <= matchFrames) {
      pairs.push({
        mainTime: event.time,
        errorMs: nearest.diff / mainRate * 1000,
        secondErrorMs: second ? second.diff / mainRate * 1000 : null
      })
    }
  }
  const onsetMaxMs = pairs.length ? Math.max(...pairs.map(p => Math.abs(p.errorMs))) : 0
  return {
    vacant: confident.length < 3,
    // 闸门使用稳健的局部块残余偏差；onsetMaxMs 仅作响动对听展示。
    maxErrorMs: maxLocalMs,
    localMaxMs: maxLocalMs,
    onsetMaxMs,
    pairs,
    pairCount: pairs.length,
    mainCount: mainEvents.length,
    referenceCount: refMerged.length,
    confidentBlocks: confident.length,
    ambiguousPair: localAmbiguous ? { local: true } : null
  }
}
