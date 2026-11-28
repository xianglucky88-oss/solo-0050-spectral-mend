import { request } from '../request.mjs'
import { download } from '../download.mjs'
import { fromFile, wavBlob } from '../wave-asset.mjs'
import { audition } from '../audition.mjs'
import { drawWave, drawCircle, circleDrag } from './waveform.mjs'
import { drawBands } from './bands-chart.mjs'

const q = selector => document.querySelector(selector)
const BASE = '/api/fold-mend/'
const form = q('#circle-form')
const listen = audition(q('audio'))
const STATUS_TEXT = { empty: '无有效内容', single: '单侧有声 · 不标相消', normal: '折叠正常', cancel: '相消 · 可挽回' }
const fmtHz = value => value >= 1000 ? `${+(value / 1000).toFixed(1)}k` : `${value}`

let source, view, foldWav, product, checked = new Set(), busy = false
const note = text => { q('#status').textContent = text }

function refresh() {
  q('#apply').disabled = busy || !view || checked.size === 0
  q('#product-play').disabled = !product
  q('#download-product').disabled = !product
  for (const box of document.querySelectorAll('#band-list input')) {
    box.disabled = box.dataset.status !== 'cancel' || busy
  }
}

function controls(on) {
  for (const el of [form.elements.start, form.elements.end, q('#apply-circle')]) el.disabled = !on
  q('#fold-play').disabled = !on
  q('#download-fold').disabled = !on
  refresh()
}

function renderBands() {
  const list = q('#band-list')
  list.replaceChildren(...view.bands.map(band => {
    const li = document.createElement('li')
    li.dataset.status = band.status
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.dataset.status = band.status
    box.checked = checked.has(band.index)
    box.onchange = () => {
      if (box.checked) checked.add(band.index)
      else checked.delete(band.index)
      invalidate()
      refresh()
    }
    const text = document.createElement('span')
    const db = band.db === null ? '−∞' : `${band.db} dB`
    text.textContent = `${fmtHz(band.low)}–${fmtHz(band.high)} Hz · 合计 ${band.combined} 码 · 折叠 ${band.fold} 码 · ${db} · ${STATUS_TEXT[band.status]}`
    label.append(box, text)
    li.append(label)
    return li
  }))
}

function renderAll() {
  form.elements.start.value = view.circle.start.toFixed(3)
  form.elements.end.value = view.circle.end.toFixed(3)
  q('#source-info').textContent = `${view.frames} 帧 · ${view.rate} 赫兹 · 双声道`
  q('#max-time').textContent = `${view.duration.toFixed(3)} 秒`
  drawWave(q('#wave'), view.peaks)
  drawCircle(q('#circle'), view.circle, view.duration)
  drawBands(q('#bands'), view.bands)
  renderBands()
  refresh()
}

function clearAll() {
  for (const id of ['#wave', '#circle', '#bands']) {
    const canvas = q(id)
    canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height)
  }
  q('#band-list').replaceChildren()
  q('#verify').textContent = ''
  q('#source-info').textContent = '左右平均会让部分声音消失，圈时间比较电平并挽回相消频带'
  q('#max-time').textContent = ''
}

function show(which, keepPosition = true) {
  const wav = which === 'fold' ? foldWav : product?.wav
  if (!wav) return
  listen(wav, keepPosition)
  q('#fold-play').setAttribute('aria-pressed', String(which === 'fold'))
  q('#product-play').setAttribute('aria-pressed', String(which === 'product'))
}

function invalidate() {
  if (product) {
    product = undefined
    show('fold', true)
  }
  q('#verify').textContent = ''
  refresh()
}

async function run(task) {
  if (busy) return
  busy = true
  q('main').setAttribute('aria-busy', 'true')
  refresh()
  try { await task() } catch (error) { note(error.message) }
  finally {
    busy = false
    q('main').setAttribute('aria-busy', 'false')
    refresh()
  }
}

async function load(wav, suggested) {
  source = wav
  view = undefined
  product = undefined
  foldWav = undefined
  checked = new Set()
  clearAll()
  controls(false)
  view = await request('inspect', { wav, start: suggested?.start, end: suggested?.end }, BASE)
  foldWav = (await request('fold', { wav }, BASE)).wav
  renderAll()
  controls(true)
  show('fold', false)
  note('已打开双声道录音。在波形上拖动圈时间，勾选相消频带后生成成品。')
}

async function recircle(start, end) {
  view = await request('inspect', { wav: source, start, end }, BASE)
  checked = new Set([...checked].filter(i => view.bands[i]?.status === 'cancel'))
  invalidate()
  renderAll()
  note(`圈选 ${view.circle.start.toFixed(3)}–${view.circle.end.toFixed(3)} 秒，电平比较已更新。`)
}

const openDemo = () => run(async () => {
  const sample = await request('demo', undefined, BASE)
  await load(sample.wav, sample.circle)
})
q('#demo').onclick = openDemo
q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => load(await fromFile(file)))
}
circleDrag(q('#circle'), () => view?.duration,
  temp => drawCircle(q('#circle'), temp ?? view?.circle, view?.duration ?? 1),
  (start, end) => { if (!busy) run(() => recircle(start, end)) })
form.onsubmit = event => {
  event.preventDefault()
  if (busy || !view) return
  const start = Number(form.elements.start.value), end = Number(form.elements.end.value)
  if (![start, end].every(Number.isFinite) || start < 0 || end > view.duration || end - start < 0.04) {
    note('圈选需要 0 到录音结尾之间的起止秒数，长度至少 0.04 秒。')
    return
  }
  run(() => recircle(start, end))
}
q('#apply').onclick = () => run(async () => {
  product = await request('rescue', { wav: source, start: view.circle.start, end: view.circle.end,
    bands: [...checked].sort((a, b) => a - b) }, BASE)
  const lines = product.verify.map(v => {
    const pct = Math.round(v.ratio * 100)
    const ok = v.ratio >= 0.85 && v.ratio <= 1.15
    return `${fmtHz(v.low)}–${fmtHz(v.high)} Hz：目标 ${v.target} 码 → 成品 ${v.actual} 码（${pct}%${ok ? '' : '，超出 85–115%'}）`
  })
  if (product.saturation > 0) lines.push(`饱和 ${product.saturation} 帧`)
  q('#verify').textContent = lines.join(' · ')
  show('product', true)
  note('成品已生成，可对听普通折叠与成品，或下载 PCM16 WAV。')
})
q('#fold-play').onclick = () => show('fold')
q('#product-play').onclick = () => show('product')
q('#download-fold').onclick = () => download(wavBlob(foldWav), 'mono-fold.wav')
q('#download-product').onclick = () => download(wavBlob(product.wav), 'mono-deliver.wav')
await openDemo()
