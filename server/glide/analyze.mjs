import { windowPlan } from '../spectrum/window.mjs'
import { spectrumFrame } from '../spectrum/frame.mjs'
import { localCoefficient, magnitude, nearestPeak } from './dft.mjs'

const GAP_HZ = 4
const PROBE_MAX = 8192

// 在圈选时段内布置分析窗（窗中心严格落在时段内），并计算各声道平均幅度谱。
function survey(audio, params) {
  const plan = windowPlan(audio.frames, 512)
  const centers = []
  for (let centerSample = Math.ceil(params.start * audio.rate);
    centerSample < params.end * audio.rate; centerSample += plan.hop) {
    centers.push(centerSample / audio.rate)
  }
  const bins = plan.size / 2 + 1
  const average = new Float64Array(bins)
  const framesPerTrack = audio.tracks.map(() => [])
  for (const center of centers) {
    const startSample = Math.round(center * audio.rate - plan.size / 2)
    audio.tracks.forEach((track, channel) => {
      const frame = spectrumFrame(track, startSample, plan)
      framesPerTrack[channel].push({ center, real: frame.real, imaginary: frame.imaginary })
      for (let k = 0; k < bins; k++) average[k] += Math.hypot(frame.real[k], frame.imaginary[k])
    })
  }
  for (let k = 0; k < bins; k++) average[k] /= centers.length * audio.tracks.length
  return { plan, centers, average, frames: framesPerTrack, binHz: audio.rate / plan.size }
}

// 精确频率 DFT 幅值：对所有分析窗与声道取平均，给出连续频率轴上的能量。
function exactMagnitude(audio, surveyResult, frequency) {
  let total = 0
  audio.tracks.forEach((track, channel) => {
    for (const { center } of surveyResult.frames[channel]) {
      total += magnitude(localCoefficient(track, center, surveyResult.plan.size,
        surveyResult.plan.hop, audio.rate, frequency))
    }
  })
  return total / (surveyResult.centers.length * audio.tracks.length)
}

// 在基频搜索范围内以 0.5Hz 细扫，用用户指定阶数的精确谐波幅值打分。
function searchF0(audio, surveyResult, params) {
  const minOrder = Math.min(...params.harmonics.map(h => h.order))
  const floor = Math.max(1, params.low)
  const ceiling = Math.min(params.high, params.nyquist / minOrder)
  if (ceiling <= floor) return []
  const scores = []
  for (let f0 = floor; f0 <= ceiling; f0 += 0.5) {
    let total = 0
    for (const { order } of params.harmonics) {
      total += exactMagnitude(audio, surveyResult, order * f0) / order
    }
    scores.push({ f0, score: total / params.harmonics.length })
  }
  scores.sort((a, b) => b.score - a.score)
  return scores
}

function median(values) {
  const sorted = Float64Array.from(values).sort()
  return sorted[Math.floor(sorted.length / 2)]
}

// 对每个指定阶定位 FFT 局部峰，校验显著性与对齐，并反推基频一致性。
function confirmHarmonics(average, binHz, params, f0, bestScore) {
  const floorLevel = median(average)
  const findings = []
  const estimates = []
  for (const { order, width } of params.harmonics) {
    const peak = nearestPeak(average, binHz, order * f0)
    const offset = Math.abs(peak.frequency - order * f0)
    const prominent = peak.magnitude > floorLevel * 3 && peak.magnitude >= bestScore * 0.18
    const aligned = offset <= binHz * 0.75
    findings.push({ order, width, carrier: order * f0, peakFrequency: peak.frequency,
      magnitude: peak.magnitude, prominent, aligned, offset })
    if (prominent && aligned) estimates.push(peak.frequency / order)
  }
  return { findings, estimates, floorLevel }
}

// 探针窗长：在不超过圈选时段采样数的前提下取 2 的幂，上限 8192（频格约 1.95Hz，可分辨 4Hz 间隔）。
function chooseProbeSize(audio, params) {
  const spanSamples = (params.end - params.start) * audio.rate
  let size = 256
  for (const candidate of [512, 1024, 2048, 4096, PROBE_MAX]) {
    if (candidate <= spanSamples) size = candidate
  }
  return size
}

// 单个时间中心处的精确 DFT 幅值。
function probeMagnitudeAt(audio, center, frequency, probeSize) {
  let total = 0
  for (const track of audio.tracks) {
    total += magnitude(localCoefficient(track, center, probeSize, probeSize / 4, audio.rate, frequency))
  }
  return total / audio.tracks.length
}

function averageMagnitude(audio, centers, frequency, probeSize) {
  const values = centers.map(center => probeMagnitudeAt(audio, center, frequency, probeSize))
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

// 旁音扫描：在载波主瓣第一零点之外，找达到载波幅值 12% 且相对内侧裙边谷显著反转的局部峰。
// 对多个稳态时间中心取平均：相干拍频平均后收敛，真实旁音在裙边谷后稳定隆起；
// 门控溅射只出现在时段边界窗而被排除；幅度调制边带峰值通常不足载波 12%，且关于载波对称，做对称抑制。
function scanForCompanions(audio, surveyResult, bands, params, probeSize) {
  const firstNull = 2 * audio.rate / probeSize // Hann 主瓣第一零点偏移（约两个频格）
  const centers = surveyResult.centers
  const steadyCenters = centers.length <= 6 ? centers : centers.slice(2, -2)
  const carrierLevel = Math.max(...bands.map(band =>
    averageMagnitude(audio, steadyCenters, band.carrier, probeSize)))
  const hits = []
  for (const band of bands) {
    const from = Math.max(1, Math.ceil(band.low - GAP_HZ))
    const to = Math.min(audio.rate / 2 - 1, band.high + GAP_HZ)
    for (let f = from; f <= to; f++) {
      if (bands.some(item => Math.abs(f - item.carrier) <= firstNull)) continue
      const level = averageMagnitude(audio, steadyCenters, f, probeSize)
      if (level < carrierLevel * 0.12) continue
      const inner = averageMagnitude(audio, steadyCenters, f - 2, probeSize)
      const outer = averageMagnitude(audio, steadyCenters, f + 1, probeSize)
      // 独立旁音：相对更靠近载波一侧的裙边谷反转隆起（>1.2 倍），且不低于外侧。
      if (!(level > inner * 1.2 && level >= outer)) continue
      // 对称抑制：镜像位置若有同量级峰，说明是幅度调制的对称边带而非独立旁音。
      const mirror = 2 * band.carrier - f
      if (mirror > 0 && mirror < audio.rate / 2) {
        const mirrorLevel = averageMagnitude(audio, steadyCenters, mirror, probeSize)
        if (mirrorLevel > level * 0.7) continue
      }
      hits.push({ frequency: f, magnitude: level })
    }
  }
  const kept = []
  for (const hit of hits) {
    if (!kept.some(other => Math.abs(other.frequency - hit.frequency) < 2)) kept.push(hit)
  }
  return kept
}

// 独占声明：各阶频带互不重叠且与旁音至少隔 4Hz；带内及带边不得有同量级旁音峰。
function checkExclusivity(audio, surveyResult, average, binHz, findings, params) {
  const blockers = []
  const bands = findings.map(item => ({
    order: item.order,
    low: item.carrier - item.width,
    high: item.carrier + item.width,
    carrier: item.carrier,
  }))
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const overlap = Math.min(bands[i].high, bands[j].high) - Math.max(bands[i].low, bands[j].low)
      if (overlap + GAP_HZ > 0) {
        blockers.push(`第 ${bands[i].order} 阶与第 ${bands[j].order} 阶声明频带间距不足 ${GAP_HZ} Hz`)
      }
    }
  }
  const strongest = Math.max(...findings.map(item => item.magnitude))
  // FFT 频格层面的强峰检查（覆盖相距较远、落在不同频格的旁音）。
  for (let k = 1; k < average.length - 1; k++) {
    if (!(average[k] > average[k - 1] && average[k] >= average[k + 1] && average[k] > strongest * 0.25)) continue
    const frequency = k * binHz
    for (const band of bands) {
      if (Math.abs(frequency - band.carrier) < binHz * 0.5) continue
      const inside = frequency >= band.low && frequency <= band.high
      const nearby = !inside && frequency > band.low - GAP_HZ && frequency < band.high + GAP_HZ
      if (inside || nearby) {
        blockers.push(`第 ${band.order} 阶频带${inside ? '内' : '边缘 4 Hz 内'}存在 ${frequency.toFixed(1)} Hz 旁音峰，无法独占`)
      }
    }
  }
  // 精确 DFT 探针：分辨同一频格内、相距仅几赫兹的旁音。
  const probeSize = chooseProbeSize(audio, params)
  const probeHits = scanForCompanions(audio, surveyResult, bands, params, probeSize)
  for (const hit of probeHits) {
    for (const band of bands) {
      const inside = hit.frequency >= band.low && hit.frequency <= band.high
      const nearby = !inside && hit.frequency > band.low - GAP_HZ && hit.frequency < band.high + GAP_HZ
      if (inside || nearby) {
        blockers.push(`第 ${band.order} 阶频带${inside ? '内' : '边缘 4 Hz 内'}存在 ${hit.frequency.toFixed(1)} Hz 旁音，无法独占`)
      }
    }
  }
  return { blockers, bands }
}

export function analyze(audio, params) {
  const surveyResult = survey(audio, params)
  const { average, binHz, centers, frames, plan } = surveyResult
  const scores = searchF0(audio, surveyResult, params)
  if (scores.length === 0) {
    return { ok: false, reason: '基频搜索范围内没有可评估的候选频率，已停在原声。', plan, centers, frames }
  }
  const best = scores[0]
  const distinctRivals = scores.filter(item => Math.abs(item.f0 - best.f0) > binHz && item.score > best.score * 0.97)
  const { findings, estimates } = confirmHarmonics(average, binHz, params, best.f0, best.score)
  const weak = findings.filter(item => !item.prominent || !item.aligned)
  let f0 = best.f0
  if (estimates.length >= 2) {
    const spread = Math.max(...estimates) - Math.min(...estimates)
    if (spread <= Math.max(2, best.f0 * 0.02)) f0 = estimates.reduce((sum, value) => sum + value, 0) / estimates.length
  }
  const { blockers: bandBlockers, bands } = checkExclusivity(audio, surveyResult, average, binHz, findings, params)
  const blockers = []
  if (distinctRivals.length) blockers.push(`基频候选 ${best.f0.toFixed(1)} Hz 与 ${distinctRivals[0].f0.toFixed(1)} Hz 得分接近，无法唯一辨认机关平音`)
  if (weak.length) blockers.push(`第 ${weak.map(item => item.order).join('、')} 阶谐波峰不显著或未对齐，无法唯一辨认`)
  if (estimates.length === 0) blockers.push('指定阶数上没有可确认的谐波峰，无法辨认机关平音')
  blockers.push(...bandBlockers)
  return {
    ok: blockers.length === 0,
    reason: blockers.length ? `${blockers.join('；')}。已停在原声。` : undefined,
    f0, blockers, bands,
    candidates: scores.slice(0, 5).map(item => ({ f0: item.f0, score: item.score })),
    harmonics: findings, plan, centers, frames, binHz,
  }
}
