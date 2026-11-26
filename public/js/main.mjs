import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'
import { selection } from './selection.mjs'
import { overlays } from './overlays.mjs'
import { fields, regionFrom, showRegions } from './regions.mjs'
import { showAudio, showMetrics } from './readouts.mjs'
import { glideParams, fillGlideForm, fillGlideFromRegion, showFindings, showGlideMetrics, inspectGlide, applyGlide } from './glide.mjs'
import { glideOverlay } from './glide-overlay.mjs'

const q = selector => document.querySelector(selector)
const repairForm = q('#repair-form')
const glideForm = q('#glide-form')
const listen = audition(q('audio'))
let source, view, repairResult, glideResult, glideAnalysis, regions = [], busy = false
const noteRepair = text => { q('#status-repair').textContent = text }
const noteGlide = text => { q('#status-glide').textContent = text }
const size = () => Number(repairForm.elements.size.value)

function redrawOverlays() {
  const canvas = q('#mask')
  overlays(canvas, regions, view.spectrum.duration, view.rate)
  if (glideAnalysis) {
    glideOverlay(canvas, currentGlideParams(), glideAnalysis, glideResult,
      view.spectrum.duration, view.rate / 2)
  }
}

function currentGlideParams() {
  try { return glideParams(glideForm) } catch { return null }
}

function show(which, keepPosition) {
  const value = which === 'repair' ? repairResult
    : which === 'glide' ? glideResult
    : { ...view, wav: source }
  if (!value) return
  spectrogram(q('#plot'), value.spectrum ?? view.spectrum)
  listen(value.wav, keepPosition)
  q('#original').setAttribute('aria-pressed', String(which === 'source'))
  q('#result-repair').setAttribute('aria-pressed', String(which === 'repair'))
  q('#result-glide').setAttribute('aria-pressed', String(which === 'glide'))
  q('#export').disabled = !value.wav || which === 'source'
}

function invalidateRepair() {
  const had = repairResult !== undefined
  repairResult = undefined
  q('#result-repair').disabled = true
  showMetrics(q('#metrics-repair'), null)
  if (had) show('source', true)
  noteRepair('选区已更新，可生成衰减修复。')
}

function invalidateGlide() {
  const had = glideResult !== undefined
  glideResult = undefined
  glideAnalysis = undefined
  q('#result-glide').disabled = true
  showFindings(q('#glide-findings'), null)
  showGlideMetrics(q('#metrics-glide'), null)
  redrawOverlays()
  if (had) show('source', true)
}

async function load(wav, preferredRepair, preferredGlide, keepRegions = false) {
  const checked = await request('inspect', { wav, size: size() })
  source = wav
  view = checked
  if (!keepRegions) regions = preferredRepair ? [preferredRepair] : []
  repairResult = undefined
  glideResult = undefined
  glideAnalysis = undefined
  q('#result-repair').disabled = q('#result-glide').disabled = q('#export').disabled = true
  for (const id of ['#original', '#apply', '#add', '#glide-inspect', '#glide-apply']) q(id).disabled = false
  showAudio(view)
  show('source', keepRegions)
  showMetrics(q('#metrics-repair'), null)
  showGlideMetrics(q('#metrics-glide'), null)
  showFindings(q('#glide-findings'), null)
  if (!keepRegions) {
    fields(repairForm, preferredRepair ?? { start: 0, end: view.spectrum.duration, low: 0, high: view.rate / 2, db: 18 })
    if (preferredGlide) fillGlideForm(glideForm, preferredGlide)
  }
  redrawOverlays()
  noteRepair('已打开原声。可拖选谱图，也可输入精确选区。')
  noteGlide(preferredGlide ? '已填入上滑音演示参数，可先辨识再生成。' : '圈选时段并填写参数后辨识机关平音。')
}

async function run(task) {
  if (busy) return
  busy = true
  q('main').setAttribute('aria-busy', 'true')
  try { await task() } catch (error) { noteGlide(error.message); noteRepair(error.message) }
  finally { busy = false; q('main').setAttribute('aria-busy', 'false') }
}

q('#demo').onclick = () => run(async () => {
  const sample = await request('demo')
  await load(sample.wav, sample.region, null)
})
q('#glide-demo').onclick = () => run(async () => {
  const sample = await request('glide-demo')
  await load(sample.wav, null, sample.params)
})
q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => load(await fromFile(file)))
}
repairForm.elements.size.onchange = () => { if (source) run(() => load(source, null, null, true)) }

selection(q('#mask'), () => view && !busy ? { duration: view.spectrum.duration, rate: view.rate } : null,
  region => {
    fields(repairForm, region)
    fillGlideFromRegion(glideForm, region)
  })

q('#add').onclick = () => run(async () => {
  if (regions.length === 8) throw new Error('最多保留 8 个选区。')
  regions = [...regions, regionFrom(repairForm, view.spectrum.duration, view.rate / 2)]
  invalidateRepair()
  redrawOverlays()
  noteRepair('已添加衰减选区。')
})
q('#apply').onclick = () => run(async () => {
  repairResult = await request('repair', { wav: source, size: size(), regions })
  q('#result-repair').disabled = false
  show('repair', true)
  showMetrics(q('#metrics-repair'), repairResult)
  noteRepair('衰减修复已生成，可切换对听并下载。')
})

q('#glide-inspect').onclick = () => run(async () => {
  const params = glideParams(glideForm)
  invalidateGlide()
  const result = await inspectGlide(source, params)
  glideAnalysis = result
  showFindings(q('#glide-findings'), result)
  redrawOverlays()
  if (result.ok) {
    noteGlide(`辨识成功：基频 ${result.f0.toFixed(2)} Hz，各阶频带独占且与旁音间隔达标，可生成上滑音。`)
    q('#glide-apply').disabled = false
  } else {
    noteGlide(result.reason || '无法唯一辨认机关平音，已停在原声。')
    q('#glide-apply').disabled = true
  }
})

q('#glide-apply').onclick = () => run(async () => {
  const params = glideParams(glideForm)
  const result = await applyGlide(source, params, size())
  if (!result.ok || !result.changed) {
    glideResult = undefined
    q('#result-glide').disabled = true
    noteGlide(result.reason || '无法唯一辨认机关平音，已停在原声。')
    return
  }
  glideResult = result
  q('#result-glide').disabled = false
  showFindings(q('#glide-findings'), glideAnalysis ?? result)
  showGlideMetrics(q('#metrics-glide'), result)
  redrawOverlays()
  show('glide', true)
  noteGlide('上滑音已生成：仅头尾各 20 毫秒过渡，圈外逐样保留，可切换对听并下载。')
})

q('#original').onclick = () => show('source', true)
q('#result-repair').onclick = () => show('repair', true)
q('#result-glide').onclick = () => show('glide', true)
q('#export').onclick = () => {
  const active = q('#result-glide').getAttribute('aria-pressed') === 'true' ? glideResult
    : q('#result-repair').getAttribute('aria-pressed') === 'true' ? repairResult : null
  if (active) download(wavBlob(active.wav), q('#result-glide').getAttribute('aria-pressed') === 'true' ? 'upward-glide.wav' : 'restored-take.wav')
}

await run(async () => {
  const sample = await request('demo')
  await load(sample.wav, sample.region, null)
})
