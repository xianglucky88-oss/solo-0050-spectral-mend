import { encode } from '../audio/encode.mjs'
import { InputError } from '../http/error.mjs'
import { decodeAudioAny } from './decode-source.mjs'
import { normalizeModel, resolveBoxes, isWorkbenchInput } from './model.mjs'
import { renderInspect, renderRepair, stitchedSpectrum, readingAt } from './render.mjs'

export const MAX_WORKBENCH_SECONDS = 6

// 允许 inspectWorkbench(wav, items, regions) / (input) 等多种调用形态。
function toInput(args) {
  if (args.length === 1 && args[0] && typeof args[0] === 'object' && !Buffer.isBuffer(args[0]) &&
      !ArrayBuffer.isView(args[0])) return args[0]
  const [wav, items, regions, extra] = args
  return { wav, items, regions, ...(extra && typeof extra === 'object' ? extra : {}) }
}

function prepare(input) {
  const nested = (input.workbench && typeof input.workbench === 'object' && !Array.isArray(input.workbench))
    ? input.workbench
    : (input.state && typeof input.state === 'object' ? input.state : null)
  const source = input.wav ?? input.audio ?? input.source ?? input.pcm ?? input.sample ??
    nested?.wav ?? nested?.audio ?? nested?.source
  const audio = decodeAudioAny(source)
  const size = Number(input.size ?? input.window ?? input.fft ?? nested?.size ?? 512)
  if (![256, 512, 1024].includes(size)) throw new InputError('窗长应为 256、512 或 1024 采样。')
  const model = normalizeModel(input, audio)
  const maxSeconds = Number(input.maxSeconds ?? input.maxDuration ?? input.durationLimit ??
    process.env.WORKBENCH_MAX_SECONDS ?? MAX_WORKBENCH_SECONDS)
  if (Number.isFinite(maxSeconds) && maxSeconds > 0 &&
      model.layout.totalFrames > Math.round(maxSeconds * audio.rate)) {
    throw new InputError(`拼接时长超出 ${maxSeconds} 秒限制；请缩短或减少片段。`)
  }
  return { audio, model, size }
}

function publicLayout(model) {
  return {
    totalFrames: model.layout.totalFrames,
    stitchedFrames: model.layout.totalFrames,
    takes: model.layout.takes,
    spans: model.layout.spans.map(({ audio, ...rest }) => rest),
    boundaries: model.layout.boundaries
  }
}

function publicItems(model) {
  return model.items.map(({ replacement, ...item }) => ({ ...item, hasReplacement: replacement !== undefined }))
}

function boxFields(model) {
  const boxes = resolveBoxes(model)
  return {
    boxes,
    selectionBoxes: boxes,
    selections: boxes,
    overlays: boxes,
    marks: boxes,
    resolvedRegions: model.regions
  }
}

export function inspectWorkbench(...args) {
  const input = toInput(args)
  const { audio, model, size } = prepare(input)
  const { masterAudio, spectrum } = renderInspect(model, size)
  const originalWav = encode(masterAudio).toString('base64')
  const duration = masterAudio.frames / audio.rate
  return {
    kind: 'workbench',
    rate: audio.rate,
    channels: audio.tracks.length,
    channelOrder: Array.from({ length: audio.tracks.length }, (_, c) => c),
    frames: masterAudio.frames,
    stitchedFrames: masterAudio.frames,
    totalFrames: masterAudio.frames,
    sourceFrames: audio.frames,
    duration,
    size,
    binHz: audio.rate / size,
    spectrum,
    originalSpectrum: spectrum,
    wav: originalWav,
    originalWav,
    pcm16: true,
    layout: publicLayout(model),
    timeline: publicLayout(model),
    arrangement: publicLayout(model),
    takes: model.layout.takes,
    spans: spectrum.spans,
    boundaries: model.layout.boundaries,
    ...boxFields(model),
    regions: model.regions,
    items: publicItems(model),
    clips: [...model.clips.values()],
    readAt: (time, hz) => readingAt(spectrum, time, hz)
  }
}

export function repairWorkbench(...args) {
  const input = toInput(args)
  const { audio, model, size } = prepare(input)
  const result = renderRepair(model, size)
  const wavBuffer = encode(result.repairedAudio)
  const wav = wavBuffer.toString('base64')
  const originalWav = encode(result.originalAudio).toString('base64')
  const originalSpectrum = stitchedSpectrum(result.originalAudio, model, size)
  const duration = result.repairedAudio.frames / audio.rate
  return {
    kind: 'workbench',
    wav,
    repairedWav: wav,
    resultWav: wav,
    downloadWav: wav,
    auditionWav: wav,
    originalWav,
    stitchedOriginalWav: originalWav,
    pcm16Wav: wav,
    pcm16: true,
    encoding: 'pcm16',
    wavBytes: wavBuffer.length,
    rate: audio.rate,
    channels: audio.tracks.length,
    channelOrder: Array.from({ length: audio.tracks.length }, (_, c) => c),
    frames: result.repairedAudio.frames,
    stitchedFrames: result.repairedAudio.frames,
    totalFrames: result.repairedAudio.frames,
    sourceFrames: audio.frames,
    duration,
    size,
    binHz: audio.rate / size,
    spectrum: result.spectrum,
    repairedSpectrum: result.spectrum,
    outputSpectrum: result.spectrum,
    originalSpectrum,
    metrics: result.metrics,
    editedWindows: result.editedWindows,
    layout: publicLayout(model),
    timeline: publicLayout(model),
    arrangement: publicLayout(model),
    takes: model.layout.takes,
    spans: result.spectrum.spans,
    boundaries: model.layout.boundaries,
    boundaryResults: result.spanResults,
    ...boxFields(model),
    regions: model.regions,
    items: publicItems(model),
    clips: [...model.clips.values()],
    readAt: (time, hz) => readingAt(result.spectrum, time, hz),
    readOriginalAt: (time, hz) => readingAt(originalSpectrum, time, hz)
  }
}

// 内置 A-B-A 工作台：同一源段 A 的两次出场夹着 B，选区绑定后一次 A。
import { demo as loadDemo } from '../audio/demo.mjs'
export function workbenchDemo() {
  const sample = loadDemo()
  const rate = 16000
  const A = { id: 'A', startFrame: Math.round(0.2 * rate), endFrame: Math.round(0.62 * rate) }
  const B = { id: 'B', startFrame: Math.round(0.86 * rate), endFrame: Math.round(1.46 * rate) }
  return {
    wav: sample.wav,
    rate,
    size: 512,
    clips: [A, B],
    items: [
      { id: 'a1', takeId: 'a1', clip: 'A' },
      { id: 'b1', takeId: 'b1', clip: 'B' },
      { id: 'a2', takeId: 'a2', clip: 'A' }
    ],
    // 两个接头都标硬切，演示两侧互不影响。
    hardCuts: ['a1', 'b1'],
    regions: [
      { id: 'box-a2', takeId: 'a2', start: 0.06, end: 0.38, low: 150, high: 1150, db: 20 }
    ]
  }
}

export { isWorkbenchInput, readingAt }
