import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { regions as normalizeClassicRegions } from '../repair/regions.mjs'
import { rebuild } from '../repair/rebuild.mjs'
import { metrics as computeMetrics } from '../repair/metrics.mjs'
import { replacementTracks } from './decode-source.mjs'

// 按布局把各片段（含等长替换声音）拼成主 PCM，并给出硬切跨度视图。
export function assemble(model) {
  const { audio, rate, layout } = model
  const channels = audio.tracks.length
  const totalFrames = layout.totalFrames
  const master = Array.from({ length: channels }, () => new Float64Array(totalFrames))
  const replacements = new Map()

  for (const item of model.items) {
    let pieceTracks
    if (item.replacement !== undefined) {
      pieceTracks = replacementTracks(audio, item.replacement, item.length)
      replacements.set(item.pid, true)
    } else {
      pieceTracks = audio.tracks.map(track => track.subarray(item.startFrame, item.endFrame))
    }
    const len = item.length
    for (let c = 0; c < channels; c++) {
      const source = pieceTracks[c] ?? pieceTracks[0]
      master[c].set(source.subarray(0, len), item.frameStart)
    }
  }
  const masterAudio = { tracks: master, rate, frames: totalFrames }
  const spans = layout.spans.map(span => ({
    ...span,
    audio: { tracks: master.map(t => t.subarray(span.frameStart, span.frameEnd)), rate, frames: span.length }
  }))
  return { masterAudio, spans, replacements }
}

// 硬切感知谱图：每个硬切跨度独立加窗，窗不会跨过硬切接头；
// 软分段已在同一跨度内被自然合并，因此“仅为定位的分段”结果完全一致。
export function stitchedSpectrum(masterAudio, model, size = 512) {
  const { rate } = masterAudio
  const binHz = rate / size
  const values = []
  const centers = []
  const spanViews = []
  for (const span of model.layout.spans) {
    const spanAudio = {
      tracks: masterAudio.tracks.map(t => t.subarray(span.frameStart, span.frameEnd)),
      rate, frames: span.length
    }
    const plan = windowPlan(span.length, size)
    const local = columns(spanAudio, plan)
    const offset = span.start
    for (let col = 0; col < local.values.length; col++) {
      values.push(local.values[col])
      const group = local.centers[col] ?? { first: 0, last: 0 }
      centers.push({ first: group.first + offset, last: group.last + offset })
    }
    spanViews.push({ ...span, spectrum: local })
  }
  return {
    values, centers, binHz, size,
    duration: masterAudio.frames / rate,
    frames: masterAudio.frames,
    spans: spanViews
  }
}

function spanRegions(model, span) {
  const result = []
  for (const region of model.regions) {
    const start = Math.max(region.startFrame, span.frameStart)
    const end = Math.min(region.endFrame, span.frameEnd)
    if (end <= start) continue
    result.push({
      start: (start - span.frameStart) / model.rate,
      end: (end - span.frameStart) / model.rate,
      low: region.low, high: region.high, db: region.db
    })
  }
  return result
}

// 工作台修复：硬切跨度各自独立重建并直接拼接，接头两侧互不影响。
export function renderRepair(model, size = 512) {
  const { rate, layout } = model
  const { masterAudio, spans } = assemble(model)
  const channels = masterAudio.tracks.length
  const repaired = Array.from({ length: channels }, () => new Float64Array(layout.totalFrames))
  let editedWindows = 0
  const spanResults = []

  for (const span of spans) {
    const localRegions = spanRegions(model, span)
    let outputTracks
    if (!localRegions.length) {
      // 没有任何选区落到本硬切跨度：逐样保留。
      outputTracks = span.audio.tracks.map(t => Float64Array.from(t))
    } else {
      const plan = windowPlan(span.length, size)
      const valid = normalizeClassicRegions(localRegions, span.audio)
      const rebuilt = rebuild(span.audio, plan, valid)
      outputTracks = rebuilt.tracks
      editedWindows += rebuilt.editedWindows
    }
    for (let c = 0; c < channels; c++) repaired[c].set(outputTracks[c], span.frameStart)
    spanResults.push({ index: span.index, frameStart: span.frameStart, frameEnd: span.frameEnd,
      regions: localRegions.length })
  }
  const repairedAudio = { tracks: repaired, rate, frames: layout.totalFrames }
  const metrics = computeMetrics(masterAudio, repairedAudio)
  const spectrum = stitchedSpectrum(repairedAudio, model, size)
  return {
    originalAudio: masterAudio,
    repairedAudio,
    metrics,
    editedWindows,
    spectrum,
    spanResults
  }
}

export function renderInspect(model, size = 512) {
  const { masterAudio } = assemble(model)
  return { masterAudio, spectrum: stitchedSpectrum(masterAudio, model, size) }
}

// 谱图读数：按时间（秒）与频率（赫兹）取最近显示列/频格的 dB 值。
export function readingAt(spectrum, time, hz) {
  if (!spectrum?.values?.length) return null
  const duration = spectrum.duration
  const t = Math.min(duration, Math.max(0, Number(time)))
  let column = 0
  if (spectrum.centers?.length) {
    let best = Infinity
    spectrum.centers.forEach((center, i) => {
      const mid = ((center.first ?? 0) + (center.last ?? center.first ?? 0)) / 2
      const d = Math.abs(mid - t)
      if (d < best) { best = d; column = i }
    })
  } else {
    column = Math.min(spectrum.values.length - 1, Math.floor(t / duration * spectrum.values.length))
  }
  const bins = spectrum.values[column].length
  const k = Math.min(bins - 1, Math.max(0, Math.round(Number(hz) / spectrum.binHz)))
  return { db: spectrum.values[column][k], column, bin: k,
    time: t, hz: k * spectrum.binHz, binHz: spectrum.binHz }
}
