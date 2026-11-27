// 落锁对轨工作台：圈改动段、填搜索范围/目标帧、生成前显示零起算源帧、
// 双路确认、搬迁、同一份 PCM16 WAV 用于试听与下载。
import { fromFile, wavBlob } from './wave-asset.mjs'
import { download as downloadBlob } from './download.mjs'

const $ = id => document.getElementById(id)
const COLORS = ['#8ab4ff', '#c79bff']
const ROWS = 2

const state = {
  wav: null, originalWav: null, rate: 16000, frames: 0,
  peaks: null, segment: { start: null, end: null },
  locks: [], // {searchStart,searchEnd,target,sourceFrame,detection,stale}
  resultWav: null, busy: false, drag: null
}

function setStatus(text, kind = '') {
  const el = $('lk-status')
  el.textContent = text
  el.className = kind === 'error' ? 'error' : kind === 'ok' ? 'ok' : ''
}

async function post(operation, body) {
  const res = await fetch(`/api/spectral-mend/${operation}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
  })
  const payload = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(payload.error || '请求失败')
  return payload
}

// ---- 浏览器端直接解析 PCM16 WAV，仅用于画波形 ----
function base64ToBuffer(base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes.buffer
}

function parseWavWave(base64, buckets = 1100) {
  const view = new DataView(base64ToBuffer(base64))
  let offset = 12, fmt = null, dataPos = 0, dataLen = 0
  while (offset + 8 <= view.buffer.byteLength) {
    const id = String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3))
    const size = view.getUint32(offset + 4, true)
    if (id === 'fmt ') fmt = { channels: view.getUint16(offset + 10, true), rate: view.getUint32(offset + 12, true), bits: view.getUint16(offset + 22, true) }
    if (id === 'data') { dataPos = offset + 8; dataLen = size; break }
    offset += 8 + size + (size % 2)
  }
  if (!fmt || fmt.bits !== 16 || !dataPos) throw new Error('仅支持 16 位 PCM WAV 波形预览。')
  const align = 2 * fmt.channels
  const frames = Math.floor(dataLen / align)
  const min = new Float32Array(buckets).fill(1)
  const max = new Float32Array(buckets).fill(-1)
  for (let f = 0; f < frames; f++) {
    let v = 0
    for (let c = 0; c < fmt.channels; c++) v = Math.max(Math.abs(v), Math.abs(view.getInt16(dataPos + f * align + c * 2, true) / 32768))
    const b = Math.min(buckets - 1, Math.floor(f / frames * buckets))
    min[b] = Math.min(min[b], -v); max[b] = Math.max(max[b], v)
  }
  return { ...fmt, frames, min, max }
}

// ---- 两行落锁表单 ----
function renderRows() {
  const host = $('lk-rows')
  host.innerHTML = ''
  state.locks = Array.from({ length: ROWS }, (_, i) => state.locks[i] ?? { searchStart: '', searchEnd: '', target: '', sourceFrame: null })
  state.locks.forEach((lock, i) => {
    const card = document.createElement('div')
    card.className = 'lk-card'
    card.style.borderColor = COLORS[i] + '88'
    card.innerHTML = `
      <h3><span>落锁 ${i + 1}</span><span class="lk-source-badge" id="lk-badge-${i}">源帧（零起算）：<b>未辨认</b></span></h3>
      <div class="lk-grid">
        <label>原声搜索起帧<input data-k="searchStart" data-i="${i}" type="number" step="1" value="${lock.searchStart ?? ''}"></label>
        <label>原声搜索止帧<input data-k="searchEnd" data-i="${i}" type="number" step="1" value="${lock.searchEnd ?? ''}"></label>
        <label>目标帧（零起算）<input data-k="target" data-i="${i}" type="number" step="1" value="${lock.target ?? ''}"></label>
      </div>`
    host.appendChild(card)
  })
  host.querySelectorAll('input').forEach(input => {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.i), k = input.dataset.k
      state.locks[i][k] = input.value === '' ? '' : Math.round(Number(input.value))
      state.locks[i].sourceFrame = null
      invalidate()
      draw()
    })
  })
}

function refreshBadges(detections) {
  state.locks.forEach((lock, i) => {
    const badge = $(`lk-badge-${i}`)
    const d = detections?.[i]
    if (d && d.unique) {
      const sl = d.leftStrength != null ? `<span class="lk-strength">L ${d.leftStrength.toFixed(2)} / R ${d.rightStrength.toFixed(2)}</span>` : ''
      badge.classList.remove('bad')
      badge.innerHTML = `源帧（零起算）：<b>${d.frame}</b>${sl}`
      lock.sourceFrame = d.frame
    } else if (d && d.unique === false) {
      badge.classList.add('bad')
      badge.innerHTML = `源帧：<b>非唯一/未找到</b>`
      lock.sourceFrame = null
    } else if (lock.sourceFrame != null) {
      badge.classList.remove('bad')
      badge.innerHTML = `源帧（零起算）：<b>${lock.sourceFrame}</b>`
    } else {
      badge.classList.remove('bad')
      badge.innerHTML = `源帧（零起算）：<b>未辨认</b>`
    }
  })
}

function invalidate() {
  state.resultWav = null
  $('lk-generate').disabled = true
  $('lk-download').disabled = true
  $('lk-result').disabled = true
  $('lk-original').disabled = !state.originalWav
  $('lk-report').hidden = true
}

// ---- 波形绘制 ----
function frameToX(frame) { const W = $('lk-wave').width; return frame / state.frames * W }
function xToFrame(clientX) {
  const canvas = $('lk-wave')
  const rect = canvas.getBoundingClientRect()
  const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width))
  return Math.round(ratio * state.frames)
}

function draw() {
  const canvas = $('lk-wave'); if (!canvas) return
  const ctx = canvas.getContext?.('2d'); if (!ctx) return
  const W = canvas.width, H = canvas.height
  ctx.clearRect(0, 0, W, H)
  ctx.fillStyle = '#111225'; ctx.fillRect(0, 0, W, H)
  const mid = H / 2
  ctx.strokeStyle = '#3a3550'; ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(W, mid); ctx.stroke()

  if (state.peaks) {
    ctx.fillStyle = '#8d86b8'
    for (let x = 0; x < W; x++) {
      const lo = state.peaks.min[x] * (H / 2 - 6), hi = state.peaks.max[x] * (H / 2 - 6)
      ctx.fillRect(x, mid - hi, 1, Math.max(1, hi - lo))
    }
  }

  const span = (a, b, fill, stroke) => {
    if (a == null || b == null || b <= a) return
    const x = frameToX(a), w = frameToX(b) - x
    ctx.fillStyle = fill; ctx.fillRect(x, 0, w, H)
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.strokeRect(x + .5, .5, Math.max(1, w) - 1, H - 1) }
  }
  // 改动段 + 首尾 16 帧保留提示
  if (state.segment.start != null && state.segment.end != null) {
    const { start: a, end: b } = state.segment
    span(a, b, '#f4b6a014', '#f4b6a0aa')
    span(a, Math.min(b, a + 16), '#ffd16633', '#ffd166')
    span(Math.max(a, b - 16), b, '#ffd16633', '#ffd166')
  }
  state.locks.forEach((lock, i) => {
    const c = COLORS[i]
    if (Number.isInteger(lock.searchStart) && Number.isInteger(lock.searchEnd)) {
      span(lock.searchStart, lock.searchEnd, c + '22', c + 'aa')
    }
    const marker = (frame, color, label) => {
      if (!Number.isInteger(frame)) return
      const x = frameToX(frame)
      ctx.strokeStyle = color; ctx.lineWidth = 2
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
      ctx.fillStyle = color; ctx.font = '12px system-ui'
      ctx.fillText(label, x + 3, 13 + i * 15)
    }
    marker(lock.sourceFrame, '#57e389', `S${i + 1}=${lock.sourceFrame ?? '?'}`)
    marker(lock.target === '' ? null : Number(lock.target), '#ffb86b', `T${i + 1}`)
  })

  if (state.drag) {
    const a = Math.min(state.drag.start, state.drag.cur), b = Math.max(state.drag.start, state.drag.cur)
    span(a, b, '#f4b6a030', '#f4b6a0')
  }
}

// ---- 圈改动段（指针拖动） ----
function initDrag() {
  const canvas = $('lk-wave')
  canvas.addEventListener('pointerdown', e => {
    if (!state.wav) return
    canvas.setPointerCapture(e.pointerId)
    const f = xToFrame(e.clientX)
    state.drag = { start: f, cur: f }
  })
  canvas.addEventListener('pointermove', e => {
    if (!state.drag) return
    state.drag.cur = xToFrame(e.clientX); draw()
  })
  const commit = e => {
    if (!state.drag) return
    let a = Math.min(state.drag.start, state.drag.cur), b = Math.max(state.drag.start, state.drag.cur)
    if (b - a < 2) b = Math.min(state.frames, a + 2)
    state.segment = { start: a, end: b }
    $('lk-seg-start').value = a; $('lk-seg-end').value = b
    state.drag = null; invalidate(); draw()
    setStatus(`已圈改动段 [${a}, ${b})（零起算半开区间）。`, '')
  }
  canvas.addEventListener('pointerup', commit)
  canvas.addEventListener('pointercancel', () => { state.drag = null; draw() })
}

function initSegmentInputs() {
  for (const key of ['start', 'end']) {
    $(`lk-seg-${key}`).addEventListener('input', e => {
      const v = e.target.value === '' ? null : Math.round(Number(e.target.value))
      state.segment[key] = Number.isInteger(v) ? v : null
      invalidate(); draw()
    })
  }
}

// ---- 组装请求 ----
function payload() {
  return {
    wav: state.wav, unit: 'frames', zeroBased: true,
    segment: { ...state.segment },
    locks: state.locks.map(l => ({
      search: { start: num(l.searchStart), end: num(l.searchEnd) },
      targetFrame: l.target === '' || l.target == null ? null : Number(l.target)
    }))
  }
}
const num = v => (v === '' || v == null ? null : Number(v))

function requireBasics() {
  if (!state.wav) throw new Error('请先打开落锁样本或导入双声道 WAV。')
  const { start, end } = state.segment
  if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) throw new Error('请先在波形上圈出改动段。')
  state.locks.forEach((l, i) => {
    if (!Number.isInteger(num(l.searchStart)) || !Number.isInteger(num(l.searchEnd)) || num(l.searchEnd) <= num(l.searchStart))
      throw new Error(`请填写落锁 ${i + 1} 有效的原声搜索范围。`)
    if (!Number.isInteger(num(l.target))) throw new Error(`请填写落锁 ${i + 1} 的目标帧。`)
  })
}

// ---- 载入音频 ----
function loadWav(wav, info = {}) {
  state.wav = wav; state.originalWav = wav; state.resultWav = null
  const wave = parseWavWave(wav)
  state.rate = info.rate ?? wave.rate; state.frames = info.frames ?? wave.frames
  state.peaks = wave
  $('lk-total-frames').textContent = `${state.frames} 帧 · ${state.rate} Hz · ${wave.channels} 声道`
  $('lk-source-info').textContent = `已载入 ${state.frames} 帧 / ${state.rate} Hz / ${wave.channels} 声道`
  $('lk-detect').disabled = false
  $('lk-original').disabled = false
  draw()
}

async function loadDemo() {
  if (state.busy) return
  setStatus('正在准备落锁样本…')
  const demo = await (await fetch('/api/spectral-mend/lock-demo')).json()
  loadWav(demo.wav, demo)
  state.segment = { ...demo.segment }
  $('lk-seg-start').value = demo.segment.start; $('lk-seg-end').value = demo.segment.end
  state.locks = demo.locks.map(l => ({ searchStart: l.search.start, searchEnd: l.search.end, target: l.targetFrame, sourceFrame: null }))
  renderRows(); draw()
  setStatus('已载入内置落锁样本，正在辨认零起算源帧…')
  await detect(true)
}

async function detect(silent) {
  requireBasics()
  state.busy = true
  try {
    const res = await post('lock-inspect', payload())
    refreshBadges(res.detections)
    draw()
    if (res.needReselect || !res.sourceFrames?.every(f => Number.isInteger(f))) {
      $('lk-generate').disabled = true
      setStatus(res.reason || '找不到唯一撞击，请重新圈选原声搜索范围。', 'error')
      return res
    }
    const geomOk = res.geometry?.ok
    if (!geomOk) {
      $('lk-generate').disabled = true
      setStatus(`源帧 ${JSON.stringify(res.sourceFrames)} 已确认，但几何不合规：${res.geometry.violations[0]?.message}`, 'error')
      return res
    }
    $('lk-generate').disabled = false
    const env = res.envelope?.feasible === false ? '；注意：按当前目标的包络预判可能接声无解' : ''
    setStatus(`已确认零起算源帧 ${JSON.stringify(res.sourceFrames)}（生成前显示）。几何合规${env}，可生成。`, 'ok')
    return res
  } finally { state.busy = false }
}

async function generate() {
  requireBasics()
  state.busy = true
  $('lk-generate').disabled = true
  try {
    // 生成前再辨认一次，确保页面显示的源帧来自本次参数。
    const preview = await post('lock-inspect', payload())
    refreshBadges(preview.detections); draw()
    const res = await post('lock-move', payload())
    if (!res.changed) {
      // 接声无解 / 非唯一 / 几何：保留原声并提示调整。
      state.resultWav = null
      useAudio(state.originalWav, false)
      $('lk-download').disabled = true; $('lk-result').disabled = true
      $('lk-original').disabled = false
      setStatus(res.reason || '无法生成，已保留原声。', 'error')
      if (res.detections) refreshBadges(res.detections)
      if (res.violations?.length) setStatus(res.violations[0].message, 'error')
      return
    }
    state.resultWav = res.wav
    res.locks?.forEach((l, i) => { if (state.locks[i]) state.locks[i].sourceFrame = l.sourceFrame })
    refreshBadges(res.detections); draw()
    $('lk-download').disabled = false
    $('lk-result').disabled = false
    showReport(res)
    useAudio(state.resultWav, true)
    setStatus(`已按原顺序搬迁：源帧 ${JSON.stringify(res.sourceFrames)} → 目标帧 ${JSON.stringify(res.targetFrames)}。试听与下载为同一份 ${res.rate} Hz 等长双声道 PCM16 WAV。`, 'ok')
  } catch (e) {
    setStatus(e.message, 'error')
  } finally { state.busy = false; $('lk-generate').disabled = false }
}

let objectUrl = null
function useAudio(base64, isResult) {
  const audio = $('lk-audio')
  if (objectUrl) URL.revokeObjectURL(objectUrl)
  const blob = wavBlob(base64)
  objectUrl = URL.createObjectURL(blob)
  audio.src = objectUrl
  audio.play?.().catch(() => {})
  $('lk-result').setAttribute('aria-pressed', String(isResult))
  $('lk-original').setAttribute('aria-pressed', String(!isResult))
}

function showReport(res) {
  const el = $('lk-report')
  el.hidden = false
  const lines = []
  lines.push(`采样率 ${res.rate} Hz｜帧数 ${res.frames}｜声道 ${res.channels}｜等长 PCM16`)
  lines.push(`源帧(零起算) ${JSON.stringify(res.sourceFrames)}`)
  lines.push(`目标帧 ${JSON.stringify(res.targetFrames)}`)
  if (res.envelope) lines.push(`包络最差越限比 ${(res.envelope.worstRatio * 100).toFixed(2)}%（阈值 ${(res.envelope.tolerance * 100).toFixed(0)}%，feasible=${res.envelope.feasible}）`)
  if (res.metrics) res.metrics.forEach((m, c) => lines.push(`声道${c} 差值RMS ${m.differenceRms.toFixed(5)} 饱和帧 ${m.saturation}`))
  if (res.gaps) lines.push(`接声间隙(帧) ${res.gaps.map(g => g.frames).join(', ')}`)
  el.textContent = lines.join('\n')
}

function downloadResult() {
  if (!state.resultWav) return
  downloadBlob(wavBlob(state.resultWav), 'lock-relocated.wav')
}

// ---- 预设 ----
function fillPreset(kind) {
  if (!state.wav) { setStatus('请先打开落锁样本。', 'error'); return }
  if (kind === 'amb') {
    state.locks[0].searchStart = 13550; state.locks[0].searchEnd = 33450
  } else if (kind === 'fade') {
    state.locks[0].target = 59950
  } else {
    state.locks[0].searchStart = 13550; state.locks[0].searchEnd = 14450; state.locks[0].target = 20000
    state.locks[1].searchStart = 32550; state.locks[1].searchEnd = 33450; state.locks[1].target = 42000
  }
  // 同步输入框
  state.locks.forEach((l, i) => {
    document.querySelector(`input[data-i="${i}"][data-k="searchStart"]`).value = l.searchStart
    document.querySelector(`input[data-i="${i}"][data-k="searchEnd"]`).value = l.searchEnd
    document.querySelector(`input[data-i="${i}"][data-k="target"]`).value = l.target
  })
  invalidate(); refreshBadges(); draw()
}

// ---- 启动 ----
window.addEventListener('DOMContentLoaded', () => {
  renderRows(); initDrag(); initSegmentInputs()
  $('lk-demo').addEventListener('click', () => loadDemo().catch(e => setStatus(e.message, 'error')))
  $('lk-file').addEventListener('change', async e => {
    const file = e.target.files[0]; e.target.value = ''
    if (!file) return
    try {
      const b64 = await fromFile(file)
      loadWav(b64)
      setStatus('已导入 WAV，请在波形上圈改动段并填写两次落锁参数。', 'ok')
    } catch (err) { setStatus(err.message, 'error') }
  })
  $('lk-detect').addEventListener('click', () => detect().catch(e => setStatus(e.message, 'error')))
  $('lk-generate').addEventListener('click', () => generate().catch(e => setStatus(e.message, 'error')))
  $('lk-download').addEventListener('click', downloadResult)
  $('lk-result').addEventListener('click', () => state.resultWav && useAudio(state.resultWav, true))
  $('lk-original').addEventListener('click', () => useAudio(state.originalWav, false))
  $('lk-preset-amb').addEventListener('click', () => fillPreset('amb'))
  $('lk-preset-fade').addEventListener('click', () => fillPreset('fade'))
  $('lk-preset-reset').addEventListener('click', () => fillPreset('reset'))
})
