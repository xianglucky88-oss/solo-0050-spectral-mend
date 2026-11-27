import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'
import { selection } from './selection.mjs'
import { overlays } from './overlays.mjs'
import { fields, regionFrom, showRegions } from './regions.mjs'
import { showAudio, showMetrics } from './readouts.mjs'

const q = selector => document.querySelector(selector)
const form = q('#spectral-form')
const listen = audition(q('audio'))
let source, view, applied, regions = [], busy = false
const note = text => { q('#status').textContent = text }
const size = () => Number(form.elements.size.value)

function mark() {
  overlays(q('#mask'), regions, view.spectrum.duration, view.rate)
  showRegions(q('#regions'), regions, index => {
    if (busy) return
    regions = regions.filter((_, i) => i !== index)
    invalidate()
    mark()
  })
}

function show(which, keepPosition) {
  const value = which === 'result' ? applied : { ...view, wav: source }
  if (!value) return
  spectrogram(q('#plot'), value.spectrum)
  listen(value.wav, keepPosition)
  q('#original').setAttribute('aria-pressed', String(which === 'source'))
  q('#result').setAttribute('aria-pressed', String(which === 'result'))
}

function invalidate() {
  const hadOutput = applied !== undefined
  applied = undefined
  for (const id of ['#result','#export']) q(id).disabled = true
  showMetrics(q('#metrics'), null)
  if (hadOutput) show('source', true)
  note('选区已更新，可生成修复结果。')
}

async function load(wav, preferred, keepRegions = false) {
  const checked = await request('inspect', { wav, size: size() })
  source = wav
  view = checked
  if (!keepRegions) regions = preferred ? [preferred] : []
  applied = undefined
  for (const id of ['#result','#export']) q(id).disabled = true
  for (const id of ['#original','#apply','#add']) q(id).disabled = false
  showAudio(view)
  show('source', keepRegions)
  showMetrics(q('#metrics'), null)
  if (!keepRegions) fields(form, preferred ?? { start: 0, end: view.spectrum.duration, low: 0, high: view.rate / 2, db: 18 })
  mark()
  note('已打开原声。可拖选谱图，也可输入精确选区。')
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
  await load(sample.wav, sample.region)
})
q('#demo').onclick = demo
q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => load(await fromFile(file)))
}
form.elements.size.onchange = () => { if (source) run(() => load(source, null, true)) }
selection(q('#mask'), () => view && !busy ? { duration: view.spectrum.duration, rate: view.rate } : null,
  region => fields(form, region))
form.onsubmit = event => {
  event.preventDefault()
  if (busy) return
  try {
    if (regions.length === 8) throw new Error('最多保留 8 个选区。')
    regions = [...regions, regionFrom(form, view.spectrum.duration, view.rate / 2)]
    invalidate()
    mark()
  } catch (error) { note(error.message) }
}
q('#apply').onclick = () => run(async () => {
  applied = await request('repair', { wav: source, size: size(), regions })
  q('#result').disabled = q('#export').disabled = false
  show('result', true)
  showMetrics(q('#metrics'), applied)
  note('修复已生成，可切换对听并下载。')
})
q('#original').onclick = () => show('source', true)
q('#result').onclick = () => show('result', true)
q('#export').onclick = () => download(wavBlob(applied.wav), 'restored-take.wav')
await demo()
