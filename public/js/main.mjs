import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'
import { selection } from './selection.mjs'
import { overlays } from './overlays.mjs'
import {
  fields, regionFrom, circleFrom, showRegions, showPoints, showTrials
} from './regions.mjs'
import { showAudio, showMetrics } from './readouts.mjs'

const q = selector => document.querySelector(selector)
const traceForm = q('#trace-form')
const regionForm = q('#region-form')
const listen = audition(q('audio'))
let source, view, applied, regions = [], busy = false
let circle = null, points = [], trace = null
const note = text => { q('#status').textContent = text }
const size = () => Number(regionForm.elements.size.value)
const mode = () => traceForm.elements.mode.value

function mark() {
  overlays(q('#mask'), { regions, circle, points, trace }, view.spectrum.duration, view.rate)
  showRegions(q('#regions'), regions, index => {
    if (busy) return
    regions = regions.filter((_, i) => i !== index)
    invalidate()
    mark()
  })
  showPoints(q('#points'), points, index => {
    if (busy) return
    points = points.filter((_, i) => i !== index)
    reconfirm()
    if (points.length >= 2) run(analyse)
  })
  showTrials(q('#trials'), trace)
}

function show(which, keepPosition) {
  const value = which === 'result' ? applied : { ...view, wav: source }
  if (!value) return
  spectrogram(q('#plot'), value.spectrum)
  listen(value.wav, keepPosition)
  q('#original').setAttribute('aria-pressed', String(which === 'source'))
  q('#result').setAttribute('aria-pressed', String(which === 'result'))
}

// Any edit to the circle, points, recording or window length invalidates the
// previous repair and the previous confirmation. The route is re-analysed from
// the source before anything can be applied again.
function invalidate(message = '设置已更新，需要重新确认嗡声路线。') {
  const hadOutput = applied !== undefined
  applied = undefined
  trace = null
  for (const id of ['#result','#export']) q(id).disabled = true
  showMetrics(q('#metrics'), null)
  if (hadOutput) show('source', true)
  note(message)
}

function reconfirm() {
  invalidate()
  mark()
}

function traceBody() {
  if (!circle || points.length < 2) return undefined
  return { range: circle, points: [...points].sort((a, b) => a.time - b.time), db: Number(traceForm.elements.db.value) }
}

async function analyse() {
  const body = traceBody()
  if (!body) { trace = null; mark(); return }
  trace = await request('trace', { wav: source, size: size(), regions, trace: body })
  mark()
  if (trace.issues?.length) note(trace.issues[0])
  else if (!trace.summary.confirmedSegments) note('没有连续三个窗以上的稳定双峰，全部标为未确认。')
  else if (!trace.pass) note('有片段未通过居中窗核对，已标为未确认并保留原样。')
  else note('路线已确认，可生成修复；未确认处会保持原样。')
}

function addPoint(point) {
  points = [...points.filter(existing => Math.abs(existing.time - point.time) > .002), point]
    .sort((a, b) => a.time - b.time)
    .slice(-32)
  reconfirm()
  if (points.length >= 2) run(analyse)
}

function setCircle(range, db = Number(traceForm.elements.db.value) || 18) {
  circle = range
  fields(traceForm, { ...range, db })
  points = []
  reconfirm()
}

async function load(wav, preferred, { keepRegions = false } = {}) {
  const previousRegions = regions
  const checked = await request('inspect', { wav, size: size() })
  source = wav
  view = checked
  // A take opened with a suggested hum route starts from the trace workflow
  // only. The rectangle attenuation entry stays available in its own form; it
  // is not pre-applied, so the companion tone is never attenuated by default.
  regions = keepRegions ? previousRegions
    : preferred?.region && !preferred?.preset ? [{ ...preferred.region }] : []
  circle = null
  points = []
  trace = null
  applied = undefined
  for (const id of ['#result','#export']) q(id).disabled = true
  for (const id of ['#original','#apply','#add','#apply-circle','#clear-points']) q(id).disabled = false
  fields(regionForm, preferred?.region ?? { start: 0, end: 0, low: 0, high: 0, db: 18 })
  fields(traceForm, { start: '', end: '', low: '', high: '', db: 18 })
  showAudio(view)
  show('source', false)
  showMetrics(q('#metrics'), null)
  mark()
  note(preferred && preferred.preset
    ? '已打开内置录音。拖选圈定嗡声时段，再在交会前后各点一次嗡声。'
    : '已打开原声。可拖选谱图圈定嗡声时段，也可输入精确数值。')
  if (preferred && preferred.preset) {
    setCircle(preferred.preset.range, preferred.preset.db)
    points = preferred.preset.points.map(point => ({ ...point }))
    await analyse()
  }
}

async function run(task) {
  if (busy) return
  busy = true
  q('main').setAttribute('aria-busy', 'true')
  try { await task() } catch (error) { note(error.message) }
  finally { busy = false; q('main').setAttribute('aria-busy', 'false') }
}

const demo = () => run(async () => {
  const sample = await request('demo')
  await load(sample.wav, { region: sample.region, preset: sample.preset })
})
q('#demo').onclick = demo
q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => load(await fromFile(file)))
}

selection(q('#mask'),
  () => view && !busy ? { duration: view.spectrum.duration, rate: view.rate, mode: mode() } : null,
  {
    point: point => { if (view && !busy) addPoint(point) },
    circle: range => { if (view && !busy) run(async () => { setCircle(range); await analyse() }) },
    region: range => { if (view && !busy) {
      fields(regionForm, range)
      note('已填入矩形选区，确认数值后添加。')
    } }
  })

traceForm.onsubmit = event => event.preventDefault()
q('#apply-circle').onclick = () => run(async () => {
  const value = circleFrom(traceForm, view.spectrum.duration, view.rate / 2)
  circle = value.range
  const { range } = value
  points = points.filter(point => point.time >= range.start && point.time <= range.end &&
    point.frequency >= range.low && point.frequency <= range.high)
  reconfirm()
  await analyse()
})
q('#clear-points').onclick = () => {
  points = []
  reconfirm()
  note('定位点已清除，请重新点取。')
}
q('#trials').onclick = event => {
  const button = event.target.closest('.suggest')
  if (!button || busy) return
  addPoint({ time: Number(button.dataset.time), frequency: Number(button.dataset.frequency) })
}
traceForm.elements.db.onchange = () => {
  if (!circle) return
  invalidate('衰减已更新，需要重新确认。')
  mark()
  run(analyse)
}

regionForm.elements.size.onchange = () => { if (source) run(async () => {
  await load(source, null, { keepRegions: true })
  note('窗长已更换，圈定与定位点已清空，需要重新确认。')
}) }

q('#add').onclick = () => {
  if (busy || !view) return
  try {
    if (regions.length === 8) throw new Error('最多保留 8 个选区。')
    regions = [...regions, regionFrom(regionForm, view.spectrum.duration, view.rate / 2)]
    invalidate('选区已更新，可生成修复结果。')
    mark()
  } catch (error) { note(error.message) }
}
regionForm.onsubmit = event => event.preventDefault()

q('#apply').onclick = () => run(async () => {
  const traceOptions = traceBody()
  // A circle without two locating points is not a confirmed route; refuse to
  // fall back silently to the rectangle path.
  if (circle && !traceOptions) {
    note('请先在交会前后各点一次嗡声，再生成修复。')
    return
  }
  if (traceOptions) {
    // Re-confirm immediately before repairing: anchors that no longer sit on a
    // unique double peak block the repair instead of being guessed past.
    const checked = await request('trace', { wav: source, size: size(), regions, trace: traceOptions })
    trace = checked
    mark()
    if (checked.issues.length) { note(checked.issues[0]); return }
    if (!checked.summary.confirmedSegments && !regions.length) {
      note('没有可确认的稳定双峰片段，暂不修复；可补点或调整圈定后重试。')
      return
    }
  }
  const body = { wav: source, size: size(), regions }
  if (traceOptions) body.trace = traceOptions
  applied = await request('repair', body)
  q('#result').disabled = q('#export').disabled = false
  show('result', true)
  showMetrics(q('#metrics'), applied)
  if (applied.trace) {
    trace = { ...trace, ...applied.trace }
    mark()
  }
  note(applied.trace
    ? '修复已生成。仅确认片段被衰减，未确认处保持原样，可切换对听并下载。'
    : '修复已生成，可切换对听并下载。')
})
q('#original').onclick = () => show('source', true)
q('#result').onclick = () => show('result', true)
q('#export').onclick = () => download(wavBlob(applied.wav), 'restored-take.wav')
await demo()
