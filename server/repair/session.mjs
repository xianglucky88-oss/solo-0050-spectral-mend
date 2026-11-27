import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { InputError } from '../http/error.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { regions } from './regions.mjs'
import { metrics } from './metrics.mjs'
import { gains } from './gains.mjs'
import { render } from './rebuild.mjs'
import { validateRange, validatePoints, validateDepth } from './route.mjs'
import {
  analyseTrace, buildTraceMasks, segmentEnvelope, verifySegments, describeTrace
} from './trace.mjs'

export function inspect(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  return {
    rate: audio.rate, frames: audio.frames, channels: audio.tracks.length,
    spectrum: columns(audio, plan)
  }
}

// Analyses the circled hum route without changing the audio: per-window double
// peak status, route segments, unconfirmed windows with their separable pairs,
// and a preview of the center-window verification the repair would have to
// pass. The page re-runs this whenever a point, the window size, the recording
// or the circle changes.
export function trace(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const spec = readTrace(input.trace, audio, plan)
  const analysis = analyseTrace(audio, plan, spec)
  const rectangle = rectangleMasks(audio, plan, input.regions)
  const outcome = compose(audio, plan, spec, analysis, rectangle)
  return reportOf(analysis, outcome)
}

// Repairs the rectangle regions (the original attenuation entry) and, when a
// trace is supplied, the confirmed hum segments only. Every confirmed segment
// must pass its center-window check before it stays in the result; a failing
// segment falls back to the rectangle/original signal and is reported as
// unconfirmed. Samples outside the circled period are copied from the source,
// so an unedited take is returned bit for bit.
export function repair(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const rectangle = rectangleMasks(audio, plan, input.regions)
  const rectangleAudio = render(audio, plan, rectangle)
  let output = rectangleAudio
  let report = null
  if (input.trace !== undefined) {
    const spec = readTrace(input.trace, audio, plan)
    const analysis = analyseTrace(audio, plan, spec)
    const outcome = compose(audio, plan, spec, analysis, rectangle)
    output = outcome.audio
    report = reportOf(analysis, outcome)
  }
  const encoded = encode(output)
  return {
    wav: encoded.toString('base64'),
    frames: audio.frames,
    editedWindows: output.editedWindows,
    metrics: metrics(audio, output),
    spectrum: columns(output, plan),
    trace: report
  }
}

function readTrace(value, audio, plan) {
  if (!value || typeof value !== 'object') throw new InputError('嗡声选区需要时段、定位点与衰减。')
  const range = validateRange(value.range, audio, plan)
  return {
    range,
    points: validatePoints(value.points, range),
    db: validateDepth(value.db)
  }
}

function rectangleMasks(audio, plan, input) {
  const list = regions(input ?? [], audio)
  const masks = new Map()
  if (!list.length) return masks
  for (const start of plan.starts) {
    const mask = gains(plan, audio, start, list)
    if (mask) masks.set(start, mask)
  }
  return masks
}

// Combined render: rectangle gains everywhere, plus the hum notch on confirmed
// windows. The trace notch is then blended out with a short cosine ramp at each
// segment edge, joining smoothly back to the rectangle/original signal. Any
// segment that fails its center-window check is dropped and the render is
// repeated with only the passing segments, so a failed segment can never leak
// into the output.
function compose(audio, plan, spec, analysis, rectangle) {
  // With no rectangle the fallback is the untouched source, so everything
  // outside the confirmed segments is returned bit for bit.
  const fallback = rectangle.size ? render(audio, plan, rectangle) : audio
  let segments = analysis.confirmed
  const rejected = []
  let last = null
  for (let attempt = 0; attempt <= analysis.confirmed.length; attempt++) {
    const masks = new Map(rectangle)
    for (const [start, notch] of buildTraceMasks(audio, plan, spec, segments)) {
      const base = masks.get(start)
      masks.set(start, base ? Float64Array.from(notch, (value, k) => value * base[k]) : notch)
    }
    const combined = render(audio, plan, masks)
    const envelope = segmentEnvelope(segments, audio.frames, plan)
    const blended = blend(combined, fallback, envelope)
    blended.editedWindows = masks.size
    const verification = verifySegments(audio, blended, plan, segments, analysis.binHz, fallback)
    const accepted = segments.filter((_, index) => verification[index].pass)
    const failed = segments.filter((_, index) => !verification[index].pass)
    for (const [index, segment] of segments.entries()) {
      if (verification[index].pass) continue
      rejected.push({
        time: segment.center.time,
        reason: 'verification',
        status: 'unverified',
        windows: segment.windows.map(window => window.time),
        verification: verification[index]
      })
    }
    last = { audio: blended, verification, accepted, segments }
    if (!failed.length) break
    segments = accepted
  }
  const acceptedTimes = new Set(last.accepted.map(segment => segment.center.time))
  return {
    audio: last.audio,
    verification: last.verification.filter(result => acceptedTimes.has(result.time)),
    accepted: last.accepted,
    rejected
  }
}

function blend(traceAudio, fallback, envelope) {
  const tracks = traceAudio.tracks.map((track, channel) => Float64Array.from(track, (value, i) =>
    fallback.tracks[channel][i] + (value - fallback.tracks[channel][i]) * envelope[i]))
  return { ...traceAudio, tracks }
}

function reportOf(analysis, outcome) {
  const description = describeTrace(analysis)
  const rejectedTimes = new Set(outcome.rejected.map(entry => entry.time))
  const remaining = description.unconfirmed.filter(entry => !rejectedTimes.has(entry.time))
  const failed = outcome.rejected.map(entry => ({
    time: round(entry.time, 4),
    status: 'unverified',
    reason: entry.reason,
    humFrequency: null,
    companionFrequency: null,
    candidate: null,
    verification: entry.verification
  }))
  const acceptedTimes = new Set(outcome.accepted.map(segment => segment.center.time))
  description.confirmed = description.confirmed.filter(segment => acceptedTimes.has(segment.center.time))
  description.summary.confirmedSegments = outcome.accepted.length
  description.summary.confirmedWindows = outcome.accepted.reduce((sum, segment) => sum + segment.count, 0)
  description.unconfirmed = [...remaining, ...failed].sort((a, b) => a.time - b.time)
  description.summary.unconfirmed = description.unconfirmed.length
  description.verification = outcome.verification.filter(result => acceptedTimes.has(result.time))
  description.pass = description.issues.length === 0 && outcome.accepted.length > 0 &&
    outcome.rejected.length === 0
  return description
}

function round(value, digits) {
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
