import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { columns } from '../spectrum/columns.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { parseGlideParams, hardGuards } from './params.mjs'
import { analyze } from './analyze.mjs'
import { synthesize } from './synthesize.mjs'
import { metrics } from '../repair/metrics.mjs'

function summary(analysis) {
  return {
    f0: analysis.f0,
    candidates: analysis.candidates,
    bands: analysis.bands,
    harmonics: analysis.harmonics.map(item => ({
      order: item.order, carrier: item.carrier, magnitude: item.magnitude,
      prominent: item.prominent, aligned: item.aligned,
    })),
  }
}

export function glideInspect(input) {
  const audio = decode(input?.wav)
  const params = parseGlideParams(input, audio)
  const guards = hardGuards(params)
  if (guards.length) return { ok: false, reason: guards.join('；'), changed: false }
  const analysis = analyze(audio, params)
  return { ok: analysis.ok, reason: analysis.reason, changed: false, ...summary(analysis) }
}

export function glide(input) {
  const audio = decode(input?.wav)
  const params = parseGlideParams(input, audio)
  const guards = hardGuards(params)
  if (guards.length) {
    return { ok: false, reason: guards.join('；'), changed: false, wav: input.wav,
      metrics: audio.tracks.map(() => ({ originalPeak: 0, outputPeak: 0, differenceRms: 0, saturation: 0 })) }
  }
  const analysis = analyze(audio, params)
  if (!analysis.ok) {
    const plan = windowPlan(audio.frames, input.size)
    return { ok: false, reason: analysis.reason, changed: false, wav: input.wav,
      spectrum: columns(audio, plan),
      metrics: audio.tracks.map(() => ({ originalPeak: 0, outputPeak: 0, differenceRms: 0, saturation: 0 })) }
  }
  const edited = synthesize(audio, params, analysis)
  const plan = windowPlan(audio.frames, input.size)
  return {
    ok: true, changed: true, ...summary(analysis),
    wav: encode(edited).toString('base64'),
    spectrum: columns(edited, plan),
    editedWindows: edited.editedWindows,
    metrics: metrics(audio, edited),
  }
}
