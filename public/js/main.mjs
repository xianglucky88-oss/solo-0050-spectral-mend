import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'
import { selection } from './selection.mjs'
import { overlays } from './overlays.mjs'
import { fields, regionFrom, showRegions } from './regions.mjs'
import { showAudio, showMetrics } from './readouts.mjs'
import { createHistory } from './history.mjs'

const q = selector => document.querySelector(selector)
const form = q('form')
const main = q('main')
const listen = audition(q('audio'))

const note = text => { q('#status').textContent = text }
const size = () => Number(form.elements.size.value)
const BASE_NOTE = '已打开原声。可拖选谱图，也可输入精确选区。'

function readForm() {
  return Object.fromEntries(['start', 'end', 'low', 'high', 'db']
    .map(name => [name, form.elements[name].value]))
}

// Restore an old version. Resident snapshots restore atomically. If an exact
// product is missing but its repair inputs are known, restoration re-issues the
// repair request; a failure here leaves the previously presented version in
// place and exposes the retry control.
async function restoreVersion(entry) {
  if (entry.productStatus === 'ready' && !entry.product?.wav) {
    if (entry.sourceWav && Array.isArray(entry.regions)) {
      const product = await request('repair', { wav: entry.sourceWav, size: entry.size, regions: entry.regions })
      return { product, productStatus: 'ready', signal: 'result' }
    }
    throw new Error('旧成品数据不完整，无法恢复。')
  }
  return entry
}

const book = createHistory({ restore: restoreVersion })
let soundKey = ''
let takeLoadSerial = 0

function defaultForm(view) {
  return { start: 0, end: view.spectrum.duration, low: 0, high: view.rate / 2, db: 18 }
}

// ---- rendering ------------------------------------------------------------

function renderRegionList(entry) {
  showRegions(q('#regions'), entry.regions, index => {
    const current = book.getState().current
    if (!current) return
    const regions = current.regions.filter((_, i) => i !== index)
    const next = book.commit({ regions, form: readForm() })
    renderFrame(next)
    renderChrome()
    note('选区已更新，可生成修复结果。')
  })
}

function renderVersionList() {
  const list = q('#versions')
  if (!list) return
  const { stack, activeId, pendingId } = book.getState()
  list.replaceChildren(...stack.map((entry, index) => {
    const item = document.createElement('li')
    const button = document.createElement('button')
    button.type = 'button'
    button.className = 'version-chip'
    button.dataset.versionId = String(entry.id)
    button.dataset.index = String(index)
    if (entry.id === activeId) button.setAttribute('aria-current', 'true')
    const parts = [`版本 ${index + 1}`, `${entry.size}`, `${entry.regions.length} 区`]
    if (entry.id === pendingId || entry.productStatus === 'pending') parts.push('生成中')
    else if (entry.productStatus === 'ready') parts.push('成品')
    else if (entry.productStatus === 'error') parts.push('生成失败')
    else parts.push('草稿')
    button.textContent = parts.join(' · ')
    button.title = entry.productStatus === 'ready'
      ? '窗长、选区、谱图、计量与修复声已保存'
      : '草稿仍可试听原声'
    button.onclick = () => activate(() => book.goTo(entry.id))
    item.append(button)
    return item
  }))
}

function renderChrome() {
  const state = book.getState()
  const entry = state.active ?? state.current
  q('#undo').disabled = !state.canUndo
  q('#redo').disabled = !state.canRedo
  renderVersionList()

  const pendingTake = main.dataset.loading === 'true'
  const pendingProduct = entry?.productStatus === 'pending' || state.pendingId === entry?.id
  main.setAttribute('aria-busy', String(Boolean(pendingTake || pendingProduct)))

  q('#apply').disabled = !entry?.sourceWav || pendingProduct
  q('#apply').dataset.pending = String(Boolean(pendingProduct))
  q('#result').disabled = entry?.productStatus !== 'ready'
  q('#export').disabled = entry?.productStatus !== 'ready'
  q('#original').disabled = !entry?.sourceWav
  q('#add').disabled = !entry?.view
  return entry
}

function presentSound(entry, keepPosition) {
  if (!entry?.sourceWav) return
  const useResult = entry.signal === 'result' && entry.productStatus === 'ready' && entry.product?.wav
  const wav = useResult ? entry.product.wav : entry.sourceWav
  // The original WAV is shared by every version of one take, so ordinary edits
  // must not reload it. Repaired audio is identity-per-version.
  const key = useResult
    ? `result:${entry.takeId}:${entry.id}:${wav.length}`
    : `source:${entry.takeId}:${wav.length}`
  if (key === soundKey && keepPosition) return
  soundKey = key
  listen(wav, keepPosition)
}

function renderFrame(entry, options = {}) {
  const target = entry ?? book.getState().active
  if (!target) return
  const keepPosition = options.keepPosition !== false

  form.elements.size.value = String(target.size)
  const formRegion = target.regions.at(-1) ?? target.form ?? (target.view ? defaultForm(target.view) : null)
  if (formRegion) fields(form, formRegion)

  if (target.view) {
    showAudio(target.view)
    const showResultSpectrum = target.signal === 'result' && target.productStatus === 'ready' && target.product?.spectrum
    spectrogram(q('#plot'), showResultSpectrum ? target.product.spectrum : target.view.spectrum)
    overlays(q('#mask'), target.regions, target.view.spectrum.duration, target.view.rate)
  }
  renderRegionList(target)
  showMetrics(q('#metrics'), target.productStatus === 'ready' ? target.product : null)

  q('#original').setAttribute('aria-pressed', String(target.signal !== 'result'))
  q('#result').setAttribute('aria-pressed', String(target.signal === 'result' && target.productStatus === 'ready'))
  q('#result').disabled = target.productStatus !== 'ready'
  q('#export').disabled = target.productStatus !== 'ready'

  const plot = q('#plot')
  plot.dataset.viewStatus = target.viewStatus
  presentSound(target, keepPosition)
  renderChrome()
}

function showRestoreError(error) {
  const box = q('#restore-error')
  if (!box) return
  if (!error) { box.hidden = true; return }
  box.hidden = false
  q('#restore-message').textContent = `旧成品恢复失败：${error.message} 切换前的内容已保留。`
}

// Run an undo/redo/version/retry activation. The history book rolls its cursor
// back to the last presented version when restoration rejects.
function activate(factory) {
  let operation
  try {
    operation = factory()
  } catch (error) {
    note(error.message)
    return
  }
  renderChrome()
  Promise.resolve(operation).then(entry => {
    if (entry) {
      soundKey = '' // navigation must re-point the player at the restored take
      renderFrame(book.getState().active ?? entry)
      showRestoreError(null)
    }
  }).catch(() => {
    renderChrome()
    showRestoreError(book.getState().error)
    note(book.getState().error?.message ?? '旧成品恢复失败，可重试。')
  })
}

// ---- WAV / demo loading ---------------------------------------------------

async function loadWav(wav, options = {}) {
  const my = ++takeLoadSerial
  book.beginTake() // invalidate late responses from the previous recording now
  main.dataset.loading = 'true'
  renderChrome()
  try {
    const checked = await request('inspect', { wav, size: size() })
    if (my !== takeLoadSerial) return // a newer WAV open is the last valid operation
    const entry = book.reset({
      sourceWav: wav,
      sourceName: options.name ?? '',
      size: size(),
      regions: options.preferred ? [options.preferred] : [],
      form: options.preferred ?? defaultForm(checked),
      view: checked,
      signal: 'source'
    })
    soundKey = ''
    renderFrame(entry, { keepPosition: false })
    showRestoreError(null)
    note(BASE_NOTE)
  } catch (error) {
    if (my === takeLoadSerial) note(error.message)
  } finally {
    if (my === takeLoadSerial) {
      main.dataset.loading = 'false'
      renderChrome()
    }
  }
}

async function openDemo() {
  book.beginTake()
  try {
    const sample = await request('demo')
    await loadWav(sample.wav, { preferred: sample.region, name: '内置录音' })
  } catch (error) { note(error.message) }
}
q('#demo').onclick = openDemo

q('#file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  fromFile(file)
    .then(wav => loadWav(wav, { name: file.name }))
    .catch(error => note(error.message))
}

// ---- window size ----------------------------------------------------------

form.elements.size.onchange = () => {
  const current = book.getState().current
  if (!current?.sourceWav) return
  const nextSize = size()
  if (nextSize === current.size && current.viewStatus === 'ready') return
  const entry = book.commit({ size: nextSize, form: readForm(), viewStatus: 'loading', viewError: null })
  renderFrame(entry)
  note('正在按新窗长计算谱图；生成、撤销和重做都可继续。')
  const token = book.beginView(entry.id)
  request('inspect', { wav: entry.sourceWav, size: nextSize })
    .then(checked => {
      const outcome = book.resolveView(token, checked)
      if (outcome === 'active') renderFrame(book.getState().active)
      else renderChrome()
    })
    .catch(error => {
      const outcome = book.rejectView(token, error.message)
      if (outcome === 'active') {
        renderFrame(book.getState().active)
        note(error.message)
      }
    })
}

// ---- spectrogram drag fills the numeric form (does not block on busy) -----

selection(q('#mask'),
  () => {
    const entry = book.getState().current
    return entry?.view ? { duration: entry.view.spectrum.duration, rate: entry.view.rate } : null
  },
  region => fields(form, region))

// ---- add region -----------------------------------------------------------

form.onsubmit = event => {
  event.preventDefault()
  const entry = book.getState().current
  if (!entry?.view) return
  try {
    if (entry.regions.length === 8) throw new Error('最多保留 8 个选区。')
    const region = regionFrom(form, entry.view.spectrum.duration, entry.view.rate / 2)
    const next = book.commit({ regions: [...entry.regions, region], form: region })
    renderFrame(next)
    note('选区已更新，可生成修复结果。')
  } catch (error) {
    note(error.message)
  }
}

// ---- generation (non-modal; stale responses cannot clobber) --------------

q('#apply').onclick = () => {
  const entry = book.getState().current
  if (!entry?.sourceWav || entry.productStatus === 'pending') return
  const token = book.begin(entry.id)
  renderChrome()
  note('正在生成修复；期间可继续编辑、撤销或重做。')
  request('repair', { wav: entry.sourceWav, size: entry.size, regions: entry.regions })
    .then(product => {
      const outcome = book.resolveProduct(token, product)
      if (outcome === 'active') {
        const ready = book.get(entry.id)
        ready.signal = 'result'
        soundKey = ''
        renderFrame(ready)
        note('修复已生成，可切换对听并下载。')
      } else {
        renderChrome()
      }
    })
    .catch(error => {
      const outcome = book.rejectProduct(token, error.message)
      if (outcome === 'active') {
        renderFrame(book.getState().active)
        note(error.message)
      } else {
        renderChrome()
      }
    })
}

// ---- A/B comparison -------------------------------------------------------

function chooseSignal(signal) {
  const entry = book.getState().active ?? book.getState().current
  if (!entry?.sourceWav) return
  if (signal === 'result' && entry.productStatus !== 'ready') return
  entry.signal = signal
  soundKey = '' // force the controller to load the newly chosen take
  renderFrame(entry)
}
q('#original').onclick = () => chooseSignal('source')
q('#result').onclick = () => chooseSignal('result')

// ---- download the exact bytes attached to this version --------------------

q('#export').onclick = () => {
  const entry = book.getState().active
  if (entry?.product?.wav) download(wavBlob(entry.product.wav), 'restored-take.wav')
}

// ---- undo / redo / retry / keyboard --------------------------------------

q('#undo').onclick = () => activate(() => book.undo())
q('#redo').onclick = () => activate(() => book.redo())
q('#retry').onclick = () => activate(() => book.retry())

document.addEventListener('keydown', event => {
  const key = event.key.toLowerCase()
  const mod = event.ctrlKey || event.metaKey
  if (!mod) return
  // Every editable control here is a numeric field/select; Ctrl/Cmd+Z is the
  // application-wide version undo rather than native text undo.
  if (key === 'z' && !event.shiftKey) {
    if (!q('#undo').disabled) { event.preventDefault(); q('#undo').click() }
  } else if (key === 'y' || (key === 'z' && event.shiftKey)) {
    if (!q('#redo').disabled) { event.preventDefault(); q('#redo').click() }
  }
})

// Minimal introspection handle for manual/automated inspection.
if (typeof globalThis !== 'undefined') {
  globalThis.spectralMend = { book, listen, renderFrame, activate }
}

renderChrome()
await openDemo()
