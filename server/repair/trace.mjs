import { InputError } from '../http/error.mjs'
import { powerSpectrum } from '../spectrum/power.mjs'
import { detectPeaks } from './peaks.mjs'
import { expectedFrequency } from './route.mjs'
import { notchMask, windowFactor } from './mask.mjs'

// Per-window classification of a hum trace. Constants follow the domain rule:
// a confirmed double peak needs at least four bins of separation and must stay
// confirmed for at least three consecutive windows. Windows where the hum and
// companion merge, vanish or cannot be uniquely attributed stay unconfirmed
// instead of being guessed.
export const TOLERANCE_BINS = 1.6
export const UNIQUENESS_BINS = 1
export const MIN_SEPARATION_BINS = 4
export const MIN_RUN_WINDOWS = 3
export const PEAK_PROMINENCE_DB = 30
export const HUM_DROP_DB = 6
export const COMPANION_CHANGE_DB = 1

// Internal analysis. Keeps raw window records (window start, sub-bin peak
// frequencies) so the renderer can build masks and the verifier can re-measure
// exactly what was classified.
export function analyseTrace(audio, plan, trace) {
  const binHz = audio.rate / plan.size
  const windows = plan.starts.filter(start => {
    const center = start + plan.size / 2
    return center >= trace.range.start * audio.rate && center <= trace.range.end * audio.rate
  }).map(start => {
    const time = (start + plan.size / 2) / audio.rate
    const values = powerSpectrum(audio, start, plan)
    const peaks = detectPeaks(values, trace.range.low, trace.range.high, binHz,
      { prominence: PEAK_PROMINENCE_DB })
    const expected = expectedFrequency(trace.points, time)
    return { start, time, expected, ...classify(peaks, expected, binHz) }
  })
  if (!windows.length) throw new InputError('圈定的时段不足以容纳一个分析窗。')
  const issues = anchorIssues(windows, trace.points)
  const { confirmed, unconfirmed } = segments(windows)
  // Without two valid anchors the route is not attributable, so nothing is
  // treated as confirmed; clean windows are still listed, one by one, as
  // unconfirmed instead of being silently dropped.
  const accepted = issues.length ? [] : confirmed
  const kept = issues.length
    ? [...unconfirmed, ...windows.filter(window => window.status === 'double')
        .map(window => entry(window, 'unanchored', 'anchor-invalid'))]
      .sort((a, b) => a.time - b.time)
    : unconfirmed
  return {
    binHz,
    windows,
    issues,
    confirmed: accepted,
    unconfirmed: kept,
    summary: summarise(windows, accepted, kept)
  }
}

function classify(peaks, expected, binHz) {
  const byDistance = [...peaks].sort((a, b) =>
    Math.abs(a.frequency - expected) - Math.abs(b.frequency - expected))
  const nearest = byDistance[0], next = byDistance[1]
  // A clean pair anywhere in the band is kept as a candidate for an extra
  // locating point even when the current route misses it.
  const candidate = separablePair(peaks, expected, binHz)
  if (!nearest || Math.abs(nearest.frequency - expected) > TOLERANCE_BINS * binHz) {
    return { status: 'missing', reason: 'no-hum', hum: null, companion: null, separation: null, candidate }
  }
  if (next && Math.abs(next.frequency - expected) - Math.abs(nearest.frequency - expected) <
      UNIQUENESS_BINS * binHz) {
    return { status: 'ambiguous', reason: 'route-tie', hum: null, companion: null, separation: null, candidate }
  }
  const hum = nearest
  const companion = nearestOther(peaks, hum)
  if (!companion) {
    return { status: 'merged', reason: 'single-peak', hum, companion: null, separation: null, candidate }
  }
  const separation = Math.abs(companion.frequency - hum.frequency) / binHz
  if (separation < MIN_SEPARATION_BINS) {
    return { status: 'merged', reason: 'separation<4', hum, companion, separation, candidate }
  }
  return { status: 'double', reason: 'ok', hum, companion, separation, candidate }
}

function nearestOther(peaks, hum) {
  return peaks.filter(peak => peak.bin !== hum.bin)
    .sort((a, b) => Math.abs(a.frequency - hum.frequency) - Math.abs(b.frequency - hum.frequency))[0]
}

// The strongest double peak in the band regardless of the route. The pair
// member closer to the expected route is treated as the hum, so a suggested
// point cannot accidentally land on the companion line.
function separablePair(peaks, expected, binHz) {
  for (const first of [...peaks].sort((a, b) => b.level - a.level)) {
    const second = nearestOther(peaks, first)
    if (!second) continue
    const separation = Math.abs(second.frequency - first.frequency) / binHz
    if (separation < MIN_SEPARATION_BINS) continue
    const pair = [first, second].sort((a, b) =>
      Math.abs(a.frequency - expected) - Math.abs(b.frequency - expected))
    return { hum: pair[0], companion: pair[1], separation }
  }
  return null
}

// Every locating point must itself sit on a uniquely attributable, separable
// double peak. Otherwise the route would be built on a guess: the analysis
// still returns the full per-window evidence, but repair is refused until the
// point is moved.
function anchorIssues(windows, points) {
  const step = windows.length > 1 ? windows[1].time - windows[0].time : 0
  const issues = []
  points.forEach((point, index) => {
    let nearest = windows[0]
    for (const window of windows) {
      if (Math.abs(window.time - point.time) < Math.abs(nearest.time - point.time)) nearest = window
    }
    if (Math.abs(nearest.time - point.time) > Math.max(2 * step, 0.05)) {
      issues.push(`第 ${index + 1} 个定位点（${point.time.toFixed(2)} 秒）附近没有分析窗。`)
    } else if (nearest.status !== 'double') {
      issues.push(`第 ${index + 1} 个定位点（${point.time.toFixed(2)} 秒）处没有唯一可分的双峰，` +
        '请在交会前后重新点取。')
    }
  })
  return issues
}

// Splits the window list into runs of confirmed double peaks and keeps only
// runs of at least three consecutive windows. Everything else stays
// unconfirmed and is kept window by window for individual review.
function segments(windows) {
  const confirmed = [], unconfirmed = []
  let run = []
  const flush = () => {
    if (!run.length) return
    if (run.length >= MIN_RUN_WINDOWS) confirmed.push(segment(run))
    else for (const window of run) unconfirmed.push(entry(window, 'short-run', 'run<3'))
    run = []
  }
  for (const window of windows) {
    if (window.status === 'double') run.push(window)
    else {
      flush()
      unconfirmed.push(entry(window, window.status, window.reason))
    }
  }
  flush()
  unconfirmed.sort((a, b) => a.time - b.time)
  return { confirmed, unconfirmed }
}

function entry(window, status, reason) {
  return {
    time: window.time, status, reason,
    hum: window.hum, companion: window.companion,
    separation: window.separation, candidate: window.candidate
  }
}

function segment(windows) {
  return {
    start: windows[0].time,
    end: windows[windows.length - 1].time,
    count: windows.length,
    center: windows[Math.floor((windows.length - 1) / 2)],
    windows
  }
}

function summarise(windows, confirmed, unconfirmed) {
  const counts = { double: 0, merged: 0, missing: 0, ambiguous: 0 }
  for (const window of windows) counts[window.status]++
  return {
    analysed: windows.length,
    double: counts.double,
    merged: counts.merged,
    missing: counts.missing,
    ambiguous: counts.ambiguous,
    confirmedSegments: confirmed.length,
    confirmedWindows: confirmed.reduce((sum, segment) => sum + segment.count, 0),
    unconfirmed: unconfirmed.length
  }
}

// Builds one mask entry per confirmed window. Only windows whose whole support
// lies inside the circled period are masked, so nothing outside the circle can
// change. Edge windows of a run carry reduced depth so the edit fades smoothly
// back into the original; the centre window of a run of three or more always
// carries full depth, which is the window used for verification.
export function buildTraceMasks(audio, plan, trace, segments) {
  const binHz = audio.rate / plan.size
  const firstSample = Math.ceil(trace.range.start * audio.rate)
  const lastSample = Math.floor(trace.range.end * audio.rate)
  const masks = new Map()
  for (const segment of segments) {
    for (const [index, window] of segment.windows.entries()) {
      if (window.start < firstSample || window.start + plan.size > lastSample) continue
      const factor = windowFactor(index, segment.windows.length)
      masks.set(window.start, notchMask(plan, binHz, window.hum.frequency, trace.db, factor))
    }
  }
  return masks
}

// Per-sample weight of the trace edit for the confirmed segments. The weight is
// 1 across the full support of the masked windows and falls to 0 over a short
// cosine ramp at each edge. The ramp is capped at the distance from the center
// window's support to the run edge, so the center window used for verification
// always sits entirely in the flat part and transitions never occupy it.
export function segmentEnvelope(segments, frames, plan) {
  const envelope = new Float64Array(frames)
  for (const segment of segments) {
    const windows = segment.windows
    const first = windows[0].start
    const last = windows[windows.length - 1].start + plan.size
    const index = Math.floor((windows.length - 1) / 2)
    const leftGap = windows[index].start - first
    const rightGap = last - (windows[index].start + plan.size)
    const width = Math.max(0, Math.min(2 * plan.hop, leftGap, rightGap))
    for (let i = Math.max(0, first); i < Math.min(frames, last); i++) {
      const fromStart = width ? (i - first) / width : 1
      const fromEnd = width ? (last - 1 - i) / width : 1
      const factor = .5 - .5 * Math.cos(Math.PI * Math.max(0, Math.min(1, fromStart, fromEnd)))
      envelope[i] = Math.max(envelope[i], factor)
    }
  }
  return envelope
}

// Level of the local maximum within one bin of `frequency`. The hum notch is
// only a few bins wide, so a companion four or more bins away stays clear of
// this measurement.
export function levelNear(values, frequency, binHz, span = 1) {
  const center = frequency / binHz
  const first = Math.max(1, Math.floor(center - span))
  const last = Math.min(values.length - 2, Math.ceil(center + span))
  let level = -Infinity
  for (let k = first; k <= last; k++) level = Math.max(level, values[k])
  return level
}

// Verification for each confirmed segment: the middle window of the run must
// show at least 6 dB of hum removal and the hum notch itself must leave the
// companion within 1 dB of where the fallback signal had it. The middle window
// never sits on a transition, so the edge fade does not distort the check.
// `fallback` is the rectangle/original render; measuring the companion against
// it keeps a deliberate rectangle attenuation from being blamed on the notch.
export function verifySegments(before, after, plan, segments, binHz, fallback = before) {
  return segments.map(segment => {
    const window = segment.center
    const original = powerSpectrum(before, window.start, plan)
    const repaired = powerSpectrum(after, window.start, plan)
    const reference = fallback === before ? original : powerSpectrum(fallback, window.start, plan)
    const humDropDb = levelNear(original, window.hum.frequency, binHz) -
      levelNear(repaired, window.hum.frequency, binHz)
    const companionChangeDb = levelNear(repaired, window.companion.frequency, binHz) -
      levelNear(original, window.companion.frequency, binHz)
    const companionNotchChangeDb = levelNear(repaired, window.companion.frequency, binHz) -
      levelNear(reference, window.companion.frequency, binHz)
    return {
      time: round(window.time, 4),
      humFrequency: round(window.hum.frequency, 2),
      companionFrequency: round(window.companion.frequency, 2),
      humDropDb: round(humDropDb, 2),
      companionChangeDb: round(companionChangeDb, 2),
      companionNotchChangeDb: round(companionNotchChangeDb, 2),
      pass: humDropDb >= HUM_DROP_DB && Math.abs(companionNotchChangeDb) < COMPANION_CHANGE_DB
    }
  })
}

// Serializable description for the API and the page. Raw spectra stay on the
// server; only peak locations, statuses and the analysis summary are exposed.
export function describeTrace(analysis) {
  return {
    binHz: round(analysis.binHz, 4),
    issues: analysis.issues,
    summary: analysis.summary,
    confirmed: analysis.confirmed.map(segment => ({
      start: round(segment.start, 4),
      end: round(segment.end, 4),
      count: segment.count,
      center: {
        time: round(segment.center.time, 4),
        humFrequency: round(segment.center.hum.frequency, 2),
        companionFrequency: round(segment.center.companion.frequency, 2),
        separation: round(segment.center.separation, 2)
      }
    })),
    unconfirmed: analysis.unconfirmed.map(entry => ({
      time: round(entry.time, 4),
      status: entry.status,
      reason: entry.reason,
      humFrequency: entry.hum ? round(entry.hum.frequency, 2) : null,
      companionFrequency: entry.companion ? round(entry.companion.frequency, 2) : null,
      candidate: entry.candidate ? {
        time: round(entry.time, 4),
        humFrequency: round(entry.candidate.hum.frequency, 2),
        companionFrequency: round(entry.candidate.companion.frequency, 2),
        separation: round(entry.candidate.separation, 2)
      } : null
    })),
    windows: analysis.windows.map(window => ({
      time: round(window.time, 4),
      expected: round(window.expected, 2),
      status: window.status,
      humFrequency: window.hum ? round(window.hum.frequency, 2) : null,
      companionFrequency: window.companion ? round(window.companion.frequency, 2) : null
    }))
  }
}

function round(value, digits) {
  if (!Number.isFinite(value)) return value
  const scale = 10 ** digits
  return Math.round(value * scale) / scale
}
