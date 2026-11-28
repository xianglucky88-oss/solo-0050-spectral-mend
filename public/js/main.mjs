import { fetchDemo, openWav, fetchView, fetchAudition, fetchGenerate } from './api.mjs'
import { download } from './download.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'
import { selection } from './selection.mjs'
import { overlays } from './overlays.mjs'
import { minimap } from './minimap.mjs'
import { createViewport } from './viewport.mjs'
import { fields, regionFrom, showRegions, assertCapacity } from './regions.mjs'
import { showAudio, showView, showMetrics } from './readouts.mjs'
import { MAX_UPLOAD_BYTES } from './limits.mjs'

const q = selector => document.querySelector(selector)
const form = q('form')
const player = audition(q('audio'))
let session, viewport, spectrum, regions = [], busy = false
let currentPair = null // 当前试听扇区的 { original, repaired, range }
let activeSignal = 'source'
const note = text => { q('#status').textContent = text }
const size = () => Number(form.elements.size.value)

function redrawOverlays() {
  if (!session || !viewport) return
  overlays(q('#mask'), regions, viewport.view(), session.rate, player.absoluteTime())
  showRegions(q('#regions'), regions, index => {
    if (busy) return
    regions = regions.filter((_, i) => i !== index)
    invalidateAudition()
    redrawOverlays()
  })
}

async function renderView() {
  if (!session) return
  const v = viewport.view()
  spectrum = await fetchView(session.token, size(), v.start, v.end)
  spectrogram(q('#plot'), spectrum.spectrum)
  showView(v)
  minimap(q('#mini'), session.envelope, v, session.duration)
  redrawOverlays()
}

function invalidateAudition() {
  // 选区或窗长变化后，已生成的试听失效，需要重新生成才能听到修复声。
  currentPair = null
  q('#result').disabled = true
  q('#export').disabled = true
  showMetrics(q('#metrics'), null)
}

function setSignal(which, keepPosition = true) {
  if (!currentPair) return
  activeSignal = which
  const payload = which === 'result' ? currentPair.repaired : currentPair.original
  player.play(payload, currentPair.range, { keepPosition })
  q('#original').setAttribute('aria-pressed', String(which === 'source'))
  q('#result').setAttribute('aria-pressed', String(which === 'result'))
}

async function run(task) {
  if (busy) return
  busy = true
  q('main').setAttribute('aria-busy', 'true')
  try { await task() } catch (error) { note(error.message) }
  finally { busy = false; q('main').setAttribute('aria-busy', 'false') }
}

async function load(blob, preferred) {
  invalidateAudition()
  const opened = await openWav(blob)
  if (!opened.complete) {
    note(opened.reason || '文件不完整，已拒绝生成。')
    session = null
    disableNav(true)
    return
  }
  session = { ...opened, envelope: opened.envelope ?? [] }
  viewport = createViewport(session.duration)
  viewport.onChange(() => run(renderView))
  regions = preferred ? [preferred] : []
  activeSignal = 'source'
  disableNav(false)
  showAudio(session)
  fields(form, preferred ?? { start: 0, end: session.duration, low: 0, high: session.rate / 2, db: 18 })
  await renderView()
  redrawOverlays()
  note(opened.longMode
    ? '长录音模式：仅在选框内平滑衰减目标频带，圈外原样。可平移缩放谱图。'
    : '短录音模式：与旧版入口逐样兼容。')
}

function disableNav(disabled) {
  for (const id of ['#zoom-in', '#zoom-out', '#pan-left', '#pan-right', '#reset-view',
    '#jump', '#jump-go', '#audition', '#add', '#apply']) q(id).disabled = disabled
  q('#original').disabled = true
  q('#result').disabled = true
  q('#export').disabled = true
}

// --- 事件接线 ---
q('#demo').onclick = () => run(async () => {
  const sample = await fetchDemo()
  const bytes = Uint8Array.from(atob(sample.wav), c => c.charCodeAt(0))
  await load(new Blob([bytes], { type: 'audio/wav' }), sample.region)
})

q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  if (file.size > MAX_UPLOAD_BYTES) { note('音频文件超出五分钟 WAV 的大小限制。'); return }
  run(async () => load(file))
}

q('#zoom-in').onclick = () => run(async () => viewport.zoom(0.5))
q('#zoom-out').onclick = () => run(async () => viewport.zoom(2))
q('#pan-left').onclick = () => run(async () => viewport.pan(-0.8))
q('#pan-right').onclick = () => run(async () => viewport.pan(0.8))
q('#reset-view').onclick = () => run(async () => viewport.reset())
q('#jump-go').onclick = () => run(async () => {
  const t = Number(q('#jump').value)
  if (Number.isFinite(t)) viewport.jumpTo(t)
})

selection(q('#mask'), () => session && !busy ? { view: viewport.view(), rate: session.rate } : null,
  region => fields(form, region))

form.onsubmit = event => {
  event.preventDefault()
  if (busy || !session) return
  try {
    assertCapacity(regions.length)
    regions = [...regions, regionFrom(form, session.duration, session.rate / 2)]
    invalidateAudition()
    redrawOverlays()
    note('选区已更新（锚定原始坐标）。生成试听后可对听。')
  } catch (error) { note(error.message) }
}

form.elements.size.onchange = () => { if (session) run(async () => { invalidateAudition(); await renderView() }) }

// 生成当前视区（≤10 秒）的成对试听，整件生成前即可听到修复结果。
q('#apply').onclick = () => run(async () => {
  const range = viewport.auditionRange()
  const pair = await fetchAudition(session.token, size(), range, regions)
  currentPair = { original: pair.original, repaired: pair.repaired, range: { start: pair.start, end: pair.end } }
  q('#original').disabled = false
  q('#result').disabled = false
  q('#export').disabled = false
  setSignal('result', false)
  showMetrics(q('#metrics'), { editedWindows: pair.editedWindows })
  note('试听已生成：可切换原声/修复，重叠部分与下载逐样一致。')
})

q('#audition').onclick = () => run(async () => {
  if (!currentPair) { q('#apply').click(); return }
  setSignal(activeSignal, false)
})

q('#original').onclick = () => setSignal('source', true)
q('#result').onclick = () => setSignal('result', true)

// 整件导出：长录音流式下载，短录音服务端复用旧 repair，字节与旧入口相同。
q('#export').onclick = () => run(async () => {
  const blob = await fetchGenerate(session.token, size(), regions)
  download(blob, 'restored-take.wav')
  note('整段 WAV 已导出，保留原始起点、采样率、声道与帧数。')
})

q('audio').addEventListener('timeupdate', () => redrawOverlays())

await q('#demo').click()
