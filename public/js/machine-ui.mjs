import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'

const q = selector => document.querySelector(selector)
const canvas = q('#m-plot')
const overlay = q('#m-overlay')
const ctx = overlay.getContext('2d')
const listen = audition(q('#m-audio'))

const state = {
  mainWav: undefined,
  refWav: undefined,
  view: undefined,
  refInfo: '',
  first: undefined,
  second: undefined,
  repairs: [],
  cal: undefined,
  alignedWav: undefined,
  applied: undefined,
  source: 'main',
  drag: undefined,
  busy: false
}

function note(text, bad = false) {
  const el = q('#m-status')
  el.textContent = text
  el.style.color = bad ? '#ff9d8a' : ''
}

function duration() {
  return state.view?.spectrum?.duration ?? 0
}

function setBusy(busy) {
  state.busy = busy
  q('#machine-lab').setAttribute('aria-busy', String(busy))
}

function invalidate() {
  state.cal = undefined
  state.alignedWav = undefined
  state.applied = undefined
  for (const id of ['#m-calibrate', '#m-generate', '#m-download', '#m-src-ref', '#m-src-result']) q(id).disabled = true
  q('#m-metrics').replaceChildren()
  if (state.source !== 'main' && state.mainWav) {
    state.source = 'main'
    listen(state.mainWav, true)
  }
  syncSourceButtons()
}

function syncSourceButtons() {
  for (const [id, key] of [['#m-src-main', 'main'], ['#m-src-ref', 'ref'], ['#m-src-result', 'result']]) {
    const button = q(id)
    button.setAttribute('aria-pressed', String(state.source === key))
  }
}

function setSource(which) {
  if (which === 'ref' && !state.alignedWav) return
  if (which === 'result' && !state.applied) return
  state.source = which
  const wav = which === 'main' ? state.mainWav : which === 'ref' ? state.alignedWav : state.applied.wav
  listen(wav, true)
  syncSourceButtons()
}

function renderLists() {
  const calList = q('#m-cal-list')
  calList.replaceChildren()
  for (const [key, label] of [['first', '前段'], ['second', '后段']]) {
    const range = state[key]
    const li = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = range ? `${label} ${range.start.toFixed(3)}–${range.end.toFixed(3)} 秒` : `${label}：未圈选`
    li.append(text)
    if (range) {
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.textContent = '移除'
      remove.onclick = () => { state[key] = undefined; invalidate(); renderAll() }
      li.append(remove)
    }
    calList.append(li)
  }
  const repairList = q('#m-repair-list')
  repairList.replaceChildren()
  state.repairs.forEach((range, index) => {
    const li = document.createElement('li')
    const text = document.createElement('span')
    text.textContent = `修复区 ${index + 1}：${range.start.toFixed(3)}–${range.end.toFixed(3)} 秒`
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.textContent = '移除'
    remove.onclick = () => { state.repairs.splice(index, 1); invalidate(); renderAll() }
    li.append(text, remove)
    repairList.append(li)
  })
}

function band(x1, x2, fill, stroke, label) {
  const W = overlay.width, H = overlay.height
  const x = Math.min(x1, x2) * W, w = Math.abs(x2 - x1) * W
  ctx.fillStyle = fill
  ctx.fillRect(x, 0, w, H)
  ctx.strokeStyle = stroke
  ctx.lineWidth = 2
  ctx.strokeRect(x + 1, 1, Math.max(1, w - 2), H - 2)
  if (label && w > 54) {
    ctx.font = '13px system-ui, sans-serif'
    ctx.fillStyle = stroke
    ctx.fillText(label, x + 6, 16)
  }
}

function drawOverlay() {
  const W = overlay.width, H = overlay.height, d = duration()
  ctx.clearRect(0, 0, W, H)
  if (!d) return
  const xOf = t => Math.max(0, Math.min(1, t / d))

  if (q('#m-coverage').checked && state.cal?.coverage?.length) {
    for (const cov of state.cal.coverage) {
      const x0 = xOf(cov.start), x1 = xOf(cov.end)
      ctx.fillStyle = 'rgba(74,222,128,0.13)'
      ctx.fillRect(x0 * W, 0, (x1 - x0) * W, H)
      ctx.strokeStyle = 'rgba(134,239,172,0.9)'
      ctx.lineWidth = 2
      ctx.strokeRect(x0 * W + 1, 1, (x1 - x0) * W - 2, H - 2)
      ctx.font = '12px system-ui, sans-serif'
      ctx.fillStyle = '#bbf7d0'
      ctx.fillText(`参考覆盖 ${cov.start.toFixed(2)}–${cov.end.toFixed(2)}s`, x0 * W + 6, H - 8)
    }
  }

  state.repairs.forEach((r, i) => band(xOf(r.start), xOf(r.end), 'rgba(251,191,36,0.16)', '#fbbf24', `修复${i + 1}`))
  if (state.first) band(xOf(state.first.start), xOf(state.first.end), 'rgba(96,165,250,0.20)', '#60a5fa', '前校准')
  if (state.second) band(xOf(state.second.start), xOf(state.second.end), 'rgba(192,132,252,0.20)', '#c084fc', '后校准')
  if (state.drag) {
    const { x0, x1 } = state.drag
    ctx.fillStyle = 'rgba(255,255,255,0.18)'
    const x = Math.min(x0, x1) * W, w = Math.abs(x1 - x0) * W
    ctx.fillRect(x, 0, w, H)
    ctx.strokeStyle = '#ffffff'
    ctx.strokeRect(x, 1, w, H - 2)
  }
}

function renderAll() {
  renderLists()
  drawOverlay()
  const ready = Boolean(state.mainWav && state.refWav && state.first && state.second)
  q('#m-calibrate').disabled = !ready || state.busy
  if (state.mainWav) q('#m-src-main').disabled = false
}

function pointFraction(event) {
  const box = overlay.getBoundingClientRect()
  return Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
}

overlay.addEventListener('pointerdown', event => {
  if (state.busy || !duration() || event.button !== 0) return
  state.drag = { x0: pointFraction(event), x1: pointFraction(event) }
  overlay.setPointerCapture(event.pointerId)
})
overlay.addEventListener('pointermove', event => {
  if (!state.drag) return
  state.drag.x1 = pointFraction(event)
  drawOverlay()
})
function commitDrag() {
  if (!state.drag) return
  const { x0, x1 } = state.drag
  state.drag = undefined
  const d = duration()
  if (Math.abs(x1 - x0) * d < 0.03) { drawOverlay(); return }
  const range = { start: Math.min(x0, x1) * d, end: Math.max(x0, x1) * d }
  assignRange(q('input[name="m-mode"]:checked').value, range)
}
overlay.addEventListener('pointerup', commitDrag)
overlay.addEventListener('pointercancel', () => { state.drag = undefined; drawOverlay() })

function assignRange(mode, range) {
  if (mode === 'repair') state.repairs.push(range)
  else state[mode] = range
  invalidate()
  renderAll()
}

q('#m-form').addEventListener('submit', event => {
  event.preventDefault()
  const data = new FormData(event.target)
  const start = Number(data.get('start')), end = Number(data.get('end'))
  if (![start, end].every(Number.isFinite) || start < 0 || end <= start || end > duration()) {
    note('请输入 0 到录音时长之间、结束晚于开始的秒数。', true)
    return
  }
  assignRange(q('input[name="m-mode"]:checked').value, { start, end })
})
q('#m-coverage').addEventListener('change', drawOverlay)

async function loadMain(wav) {
  state.mainWav = wav
  state.view = await request('inspect', { wav, size: 512 })
  spectrogram(canvas, state.view.spectrum)
  const info = state.view
  q('#m-info').textContent = `主录音 ${info.frames} 帧 · ${info.rate} Hz · ${info.channels === 1 ? '单声道' : '双声道'}${state.refInfo}`
  invalidate()
  listen(wav, false)
  renderAll()
}

async function loadRef(wav) {
  state.refWav = wav
  // 仅做格式识别，参考允许与主录音不同采样率。
  const info = await request('inspect', { wav, size: 256 })
  state.refInfo = ` ｜ 参考 ${info.frames} 帧 · ${info.rate} Hz · ${info.channels === 1 ? '单声道' : `${info.channels} 声道（按单声道混合）`}`
  if (state.view) q('#m-info').textContent = `主录音 ${state.view.frames} 帧 · ${state.view.rate} Hz · ${state.view.channels === 1 ? '单声道' : '双声道'}${state.refInfo}`
  invalidate()
  renderAll()
}

async function run(task) {
  if (state.busy) return
  setBusy(true)
  try { await task() } catch (error) { note(error.message, true) }
  finally { setBusy(false); renderAll() }
}

q('#m-main-file').addEventListener('change', event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => { note('正在读取主录音…'); await loadMain(await fromFile(file)); note('主录音已打开，请圈选前后两段纯机器声。') })
})
q('#m-ref-file').addEventListener('change', event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => { note('正在读取参考录音…'); await loadRef(await fromFile(file)); note('参考已打开。') })
})

q('#m-demo').onclick = () => run(loadDemo)

async function loadDemo() {
  note('正在打开内置双件示范并校准…')
  const demo = await request('machine-demo')
  state.first = demo.first
  state.second = demo.second
  state.repairs = [...demo.repairs]
  await loadMain(demo.mainWav)
  await loadRef(demo.referenceWav)
  state.refWav = demo.referenceWav
  renderAll()
  await doCalibrate(demo)
}

function metricLine(container, text, good) {
  const div = document.createElement('div')
  div.textContent = text
  if (good === false) div.style.color = '#ff9d8a'
  if (good === true) div.style.color = '#86efac'
  container.append(div)
}

function showCalibrationMetrics(cal) {
  const box = q('#m-metrics')
  box.replaceChildren()
  const c = cal.calibration
  metricLine(box, `开录偏移 ${c.offsetSeconds.toFixed(4)} 秒（参考采样 ${c.deltaSamples.toFixed(1)}）；恒定速率比 ${c.rateRatio.toFixed(6)}，速率差 ${c.rateDifference >= 0 ? '+' : ''}${(c.rateDifference * 100).toFixed(3)}%（${c.ppm.toFixed(0)} ppm）。`)
  metricLine(box, `各主声道带符号比例：${c.gains.map((g, i) => `声道${i + 1} ${g.toFixed(4)}`).join('，')}。`)
  cal.segments.forEach((seg, s) => seg.channels.forEach((ch, ci) => {
    metricLine(box, `${s === 0 ? '前' : '后'}校准段 · 声道${ci + 1}：RMSE ${ch.codesRmse.toFixed(2)} 码 ≤ 限值 ${ch.limitCodes.toFixed(2)} 码；占电平 ${(ch.ratio * 100).toFixed(2)}% ≤ 5%。`, ch.pass)
  }))
  metricLine(box, cal.events.vacant
    ? '未检出足够清晰的离散响动，已以全波形亚采样拟合确认对齐。'
    : `同次响动/局部对齐最大偏差 ${cal.events.maxErrorMs.toFixed(4)} 毫秒 < 1 毫秒（${cal.events.confidentBlocks} 个高置信块）。`, cal.events.vacant || cal.events.maxErrorMs < 1)
  if (cal.coverage?.length) metricLine(box, `参考覆盖主录音 ${cal.coverage.map(v => `${v.start.toFixed(2)}–${v.end.toFixed(2)} 秒`).join('，')}。`)
}

async function doCalibrate(demoHints) {
  const cal = await request('calibrate', {
    wav: state.mainWav,
    referenceWav: state.refWav,
    first: state.first,
    second: state.second
  })
  state.cal = cal
  note('校准共同达标：可在生成前同位置对听“主录音 / 校准参考”，并查看绿色参考覆盖。')
  showCalibrationMetrics(cal)
  q('#m-generate').disabled = false
  q('#m-src-ref').disabled = false
  drawOverlay()
  // 预取对齐参考，便于立即对听。
  const aligned = await request('align', {
    wav: state.mainWav, referenceWav: state.refWav,
    rho: cal.rho, delta: cal.delta, gains: cal.gains
  })
  state.alignedWav = aligned.wav
  if (demoHints?.stable) state.stableHint = demoHints.stable
}

q('#m-calibrate').onclick = () => run(async () => {
  invalidate()
  await doCalibrate()
})

q('#m-src-main').onclick = () => setSource('main')
q('#m-src-ref').onclick = () => setSource('ref')
q('#m-src-result').onclick = () => setSource('result')

q('#m-generate').onclick = () => run(async () => {
  if (!state.repairs.length) { note('请至少圈选一个修复区。', true); return }
  note('正在按校准结果做参考相减、边缘平滑与计量…')
  const payload = {
    wav: state.mainWav,
    referenceWav: state.refWav,
    rho: state.cal.rho,
    delta: state.cal.delta,
    gains: state.cal.gains,
    first: state.first,
    second: state.second,
    repairs: state.repairs,
    fadeMs: 12
  }
  if (state.stableHint) payload.stable = state.stableHint
  const result = await request('cancel', payload)
  state.applied = result
  q('#m-download').disabled = false
  q('#m-src-result').disabled = false
  state.source = 'result'
  listen(result.wav, true)
  syncSourceButtons()
  note('成品已生成：试听与下载为同一个 WAV，保持原采样率、声道与时长。')
  const box = q('#m-metrics')
  const renderBlock = (block, prefix) => block.channels.forEach((ch, c) => {
    metricLine(box, `${prefix}${block.start.toFixed(2)}–${block.end.toFixed(2)}s · 声道${c + 1}：机器声 RMS ${ch.rmsBefore.toFixed(5)} → ${ch.rmsAfter.toFixed(6)}，为修前 ${(ch.ratio * 100).toFixed(1)}%（要求低于 25%）。`, ch.passQuarter)
  })
  result.stableMetrics?.forEach(block => renderBlock(block, '稳段 '))
  if (!state.stableHint) result.cores?.forEach(block => renderBlock(block, '修复区核心 '))
  result.metrics?.forEach((m, c) => {
    metricLine(box, `声道${c + 1} 全轨差值均方根 ${m.differenceRms.toFixed(5)}，饱和帧 ${m.saturation}。`)
  })
})

q('#m-download').onclick = () => {
  if (state.applied) download(wavBlob(state.applied.wav), 'machine-cancelled.wav')
}

// 窗口尺寸变化后覆盖层按比例重绘即可（画布内部分辨率固定）。
window.addEventListener('resize', drawOverlay)

await loadDemo().catch(error => note(error.message, true))
