// 平顶检查 / 补峰成品的工作台编排：严格 WAV 解包 -> PCM16 整数规则 -> 等长 WAV。
import { decode } from '../audio/decode.mjs'
import { encodePcm16Wav } from '../audio/pcm16.mjs'
import { findFlatTops, scanRange, renderFlatTops } from './flattops.mjs'
import { metrics } from './metrics.mjs'

function toIntChannels(audio) {
  return audio.tracks.map(track => Array.from(track, value => Math.max(-32768,
    Math.min(32767, Math.round(value * 32768)))))
}

function normalizeHttpRange(raw, audio) {
  if (!raw || typeof raw !== 'object') return raw ?? {}
  const duration = audio.frames / audio.rate
  if (raw.startSample !== undefined || raw.endSample !== undefined ||
      raw.startIndex !== undefined || raw.endIndex !== undefined) {
    return raw
  }
  if (raw.start !== undefined && raw.end !== undefined) {
    const explicitSamples = input_timeSamples(raw)
    const looksLikeSamples = Number.isInteger(raw.start) && Number.isInteger(raw.end) &&
      (raw.start > duration + 1e-9 || raw.end > duration + 1e-9)
    if (explicitSamples || looksLikeSamples) {
      return { ...raw, startSample: raw.start, endSample: raw.end }
    }
    return { ...raw, startSample: Math.round(raw.start * audio.rate),
      endSample: Math.round(raw.end * audio.rate) }
  }
  return raw
}

function input_timeSamples(raw) {
  return raw.timeUnit === 'samples' || raw.unit === 'samples' || raw.unit === 'sample'
}

function rangeFromInput(input, audio) {
  let raw
  if (input.range && typeof input.range === 'object') raw = input.range
  else if (input.interval && typeof input.interval === 'object') raw = input.interval
  else if (input.circle && typeof input.circle === 'object') raw = input.circle
  else if (input.span && typeof input.span === 'object') raw = input.span
  else if (input.startSample !== undefined || input.startIndex !== undefined ||
      input.from !== undefined || input.rangeStart !== undefined ||
      input.start !== undefined || input.end !== undefined) raw = input
  else raw = {}
  return normalizeHttpRange(raw, audio)
}

function waveformPeaks(channelPcm, buckets = 1600) {
  const count = Math.min(buckets, channelPcm.length)
  const min = new Array(count)
  const max = new Array(count)
  for (let b = 0; b < count; b++) {
    const from = Math.floor(b * channelPcm.length / count)
    const to = Math.max(from + 1, Math.floor((b + 1) * channelPcm.length / count))
    let lo = Infinity, hi = -Infinity
    for (let i = from; i < to; i++) {
      if (channelPcm[i] < lo) lo = channelPcm[i]
      if (channelPcm[i] > hi) hi = channelPcm[i]
    }
    min[b] = lo
    max[b] = hi
  }
  return { buckets: count, min, max }
}

export function scan(input = {}) {
  const audio = decode(input.wav)
  const pcm = toIntChannels(audio)
  const range = rangeFromInput(input, audio)
  const options = { rate: audio.rate, frames: audio.frames,
    minLength: input.minLength, clipLevel: input.clipLevel ?? input.threshold,
    fullScaleTolerance: input.fullScaleTolerance }
  const channels = pcm.map((channelPcm, channel) => {
    const report = (range && Object.keys(range).length
      ? scanRange(channelPcm, range, { ...options, channel })
      : findFlatTops(channelPcm, { ...options, channel }))
    return { ...report, rate: audio.rate, duration: audio.frames / audio.rate,
      waveform: waveformPeaks(channelPcm, Number(input.buckets) || 1600) }
  })
  const merge = key => channels.flatMap(report => report[key] ?? [])
  const interval = channels[0]?.range ?? channels[0]?.interval ?? null
  return {
    rate: audio.rate,
    frames: audio.frames,
    duration: audio.frames / audio.rate,
    channelCount: audio.tracks.length,
    channels,
    reports: channels,
    byChannel: channels,
    channelReports: channels,
    range: interval,
    interval,
    circle: interval,
    clips: merge('clips'),
    flatTops: merge('flatTops'),
    repairable: merge('repairable'),
    repairableClips: merge('repairableClips'),
    evidence: merge('evidence'),
    unresolved: merge('unresolved'),
    insufficient: merge('insufficient'),
    transients: merge('transients'),
    spikes: merge('spikes')
  }
}

function selectionsFromInput(input, audio) {
  const rate = audio.rate
  const duration = audio.frames / rate
  const list = input.selections ?? input.selected ?? input.selectedClips ?? input.clipIds
    ?? input.ids ?? input.objects ?? input.targets ?? input.flatTops
    ?? input.clips ?? input.repairs ?? (isNewRegionShape(input.regions) ? input.regions : [])
  if (!Array.isArray(list)) return []
  // 工作台 HTTP 约定 start/end 为秒；显式 samples 或明显超出时长的整数按样点处理。
  const timeUnit = input.timeUnit ?? input.unit
  return list.map(description => {
    if (!description || typeof description !== 'object') return description
    if (description.id !== undefined || description.clipId !== undefined ||
        description.startSample !== undefined || description.startIndex !== undefined ||
        description.range !== undefined) return description
    if (description.start !== undefined && description.end !== undefined) {
      const explicitSamples = timeUnit === 'samples' || description.unit === 'samples' ||
        description.timeUnit === 'samples'
      const looksLikeSamples = Number.isInteger(description.start) && Number.isInteger(description.end) &&
        (description.start > duration + 1e-9 || description.end > duration + 1e-9)
      if (explicitSamples || looksLikeSamples) {
        return { ...description, startSample: description.start, endSample: description.end }
      }
      return { ...description,
        startSample: Math.round(description.start * rate),
        endSample: Math.round(description.end * rate),
        timeConverted: true }
    }
    return description
  })
}

export function isNewRegionShape(regions) {
  return Array.isArray(regions) && regions.length > 0 && regions.some(region => region &&
    typeof region === 'object' && !('low' in region) &&
    (('channel' in region) || ('clipId' in region) || ('kind' in region) ||
      ('startSample' in region)))
}

export function isFlatRepairRequest(input = {}) {
  if (input.mode === 'flat' || input.kind === 'flat-top' || input.workflow === 'flat' ||
      input.workflow === 'flattop' || input.op === 'declip') return true
  if (input.halve === true || input.half === true || input.halveAll === true) return true
  // regions 优先按既有频谱契约解释：空数组必须保持逐字节旁路，
  // 含 low/high/db 的是频谱选区；只有平顶形状的 region 才分流。
  if (Array.isArray(input.regions)) {
    if (input.regions.length === 0) return false
    return isNewRegionShape(input.regions)
  }
  if ([input.selections, input.selected, input.selectedClips, input.clipIds, input.ids,
       input.objects, input.targets, input.flatTops, input.repairs]
      .some(value => Array.isArray(value))) return true
  if (Array.isArray(input.clips)) return true
  return false
}

export function declip(input = {}) {
  const audio = decode(input.wav)
  const pcm = toIntChannels(audio)
  const selections = selectionsFromInput(input, audio)
  const rendered = renderFlatTops(pcm, selections, { rate: audio.rate,
    timeUnit: input.timeUnit, minLength: input.minLength,
    clipLevel: input.clipLevel ?? input.threshold, overshoot: input.overshoot })
  const wavBuffer = encodePcm16Wav({ pcm: rendered.pcm, rate: audio.rate })
  const afterTracks = rendered.pcm.map(channel => Float64Array.from(channel, value => value / 32768))
  const measure = metrics(audio, { tracks: afterTracks })
  const wav = wavBuffer.toString('base64')
  return {
    wav,
    wavBase64: wav,
    pcm: rendered.pcm,
    samples: rendered.pcm,
    output: rendered.pcm,
    rate: audio.rate,
    frames: audio.frames,
    channels: audio.tracks.length,
    channelCount: audio.tracks.length,
    length: wav.length,
    sameLength: true,
    editedWindows: rendered.results.length,
    repairedObjects: rendered.results.length,
    selected: rendered.selected,
    results: rendered.results,
    repairs: rendered.results,
    skipped: rendered.skipped,
    rejected: rendered.skipped,
    metrics: measure
  }
}
