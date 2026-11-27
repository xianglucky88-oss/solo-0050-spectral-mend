import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'
import { spectrogram } from './spectrogram.mjs'

const q = selector => document.querySelector(selector)
const qa = selector => [...document.querySelectorAll(selector)]

const audio = audition(q('#wb-audio'))
let state = { wav: null, size: 512, clips: [], items: [], hardCuts: [], regions: [] }
let rate = 16000
let view = null
let applied = null
let busy = false
let inspectTimer = null
let idSeq = 0
const nextId = p => `${p}${++idSeq}${Math.random().toString(36).slice(2, 6)}`

const note = text => { q('#wb-status').textContent = text }

// ---- 浏览器侧轻量布局（与 server/workbench/model.mjs 同构），让选框随出场即时移动 ----
function effectiveRange(item) {
  if (Number.isFinite(item.startFrame) && Number.isFinite(item.endFrame)) {
    return { startFrame: item.startFrame, endFrame: item.endFrame }
  }
  const ref = item.clip ?? item.clipId ?? item.source
  const clip = state.clips.find(c => c.id === ref)
  if (clip && Number.isFinite(clip.startFrame)) return { startFrame: clip.startFrame, endFrame: clip.endFrame }
  return { startFrame: 0, endFrame: 0 }
}

function localLayout() {
  let offset = 0
  const items = state.items.map((raw, index) => {
    const id = String(raw.id ?? raw.pid ?? `p${index + 1}`)
    const takeId = String(raw.takeId ?? raw.occurrenceId ?? id)
    const range = effectiveRange(raw)
    const len = Math.max(0, range.endFrame - range.startFrame)
    const item = { ...raw, id, takeId, ...range, length: len, frameStart: offset, frameEnd: offset + len }
    offset += len
    return item
  })
  const takes = []
  for (const item of items) {
    let take = takes.find(t => t.takeId === item.takeId)
    if (!take) { take = { takeId: item.takeId, frameStart: item.frameStart, frameEnd: item.frameEnd, items: [] }; takes.push(take) }
    take.frameStart = Math.min(take.frameStart, item.frameStart)
    take.frameEnd = Math.max(take.frameEnd, item.frameEnd)
    take.items.push(item.id)
  }
  for (const t of takes) { t.length = t.frameEnd - t.frameStart; t.start = t.frameStart / rate; t.end = t.frameEnd / rate }
  const totalFrames = offset
  const duration = totalFrames / rate
  const boxes = (state.regions ?? []).map((raw, index) => {
    const id = String(raw.id ?? `r${index + 1}`)
    const takeId = raw.takeId ?? raw.occurrenceId ?? raw.owner ?? null
    const take = takes.find(t => t.takeId === String(takeId))
    let startFrame, endFrame
    if (take) {
      const sf = raw.startFrame ?? Math.round(Number(raw.start ?? 0) * rate)
      const ef = raw.endFrame ?? Math.round(Number(raw.end ?? 0) * rate)
      startFrame = take.frameStart + sf
      endFrame = take.frameStart + ef
    } else {
      startFrame = raw.startFrame ?? Math.round(Number(raw.start ?? 0) * rate)
      endFrame = raw.endFrame ?? Math.round(Number(raw.end ?? 0) * rate)
    }
    return { id, takeId, startFrame, endFrame, start: startFrame / rate, end: endFrame / rate,
      low: Number(raw.low), high: Number(raw.high), db: Number(raw.db),
      x0: duration ? startFrame / totalFrames : 0, x1: duration ? endFrame / totalFrames : 0 }
  })
  return { items, takes, totalFrames, duration, boxes }
}

// ---- 状态操作（与服务端操作器同义）----
function swapBlocks(idA, idB) {
  const items = [...state.items]
  const ia = items.findIndex(i => i.id === idA)
  const ib = items.findIndex(i => i.id === idB)
  if (ia < 0 || ib < 0) return
  const blockRange = index => {
    const takeId = items[index].takeId ?? items[index].id
    let s = index, e = index + 1
    while (s > 0 && (items[s - 1].takeId ?? items[s - 1].id) === takeId) s--
    while (e < items.length && (items[e].takeId ?? items[e].id) === takeId) e++
    return [s, e]
  }
  const [a0, a1] = blockRange(ia), [b0, b1] = blockRange(ib)
  if (a0 === b0) { [items[ia], items[ib]] = [items[ib], items[ia]] }
  else {
    const spanA = items.slice(a0, a1), spanB = items.slice(b0, b1)
    const next = []
    for (let i = 0; i < items.length;) {
      if (i === a0) { next.push(...spanB); i = a1 }
      else if (i === b0) { next.push(...spanA); i = b1 }
      else { next.push(items[i]); i++ }
    }
    state.items = next
    return
  }
  state.items = items
}

function splitAt(id, localFrame) {
  const index = state.items.findIndex(i => i.id === id)
  if (index < 0) return
  const source = state.items[index]
  const { startFrame, endFrame } = effectiveRange(source)
  const at = startFrame + Math.round(localFrame)
  if (!(at > startFrame && at < endFrame)) { note('分段帧需落在该出场长度内。'); return }
  const takeId = source.takeId ?? source.id
  const outgoingHard = source.hardAfter === true || source.hard === true
  const rightId = nextId('p')
  const left = { ...source, takeId, startFrame, endFrame: at, hard: false, hardAfter: false }
  const right = { ...source, id: rightId, takeId, startFrame: at, endFrame,
    hard: outgoingHard, hardAfter: outgoingHard, hardBefore: false }
  state.items.splice(index, 1, left, right)
  // 原有“出场末端”硬切标记迁移到右段；新的内部分段接头保持软接。
  if (Array.isArray(state.hardCuts) && state.hardCuts.includes(source.id)) {
    state.hardCuts = state.hardCuts.filter(x => x !== source.id).concat(rightId)
  }
  invalidate()
  refresh()
}

function toggleHard(afterId) {
  const set = new Set(state.hardCuts ?? [])
  if (set.has(afterId)) set.delete(afterId); else set.add(afterId)
  state.hardCuts = [...set]
  // 只以 hardCuts 身份令牌表达“某段之后”的接头，避免笼统 hard 双向化。
  for (const item of state.items) { delete item.hard; delete item.hardAfter }
  invalidate()
  refresh()
}

// ---- 渲染 ----
function renderClips() {
  const ul = q('#wb-clips')
  ul.replaceChildren(...state.clips.map(clip => {
    const li = document.createElement('li')
    li.dataset.clipId = clip.id
    li.innerHTML = `<code>${clip.id}</code> <span class="hint">${clip.startFrame}–${clip.endFrame} 帧 · ${clip.endFrame - clip.startFrame} 帧</span>`
    const place = document.createElement('button')
    place.type = 'button'; place.textContent = '＋放到工作台'
    place.onclick = () => {
      const id = nextId('t')
      state.items.push({ id, takeId: id, clip: clip.id })
      invalidate(); refresh()
    }
    li.append(place)
    return li
  }))
  q('#wb-cut').disabled = !state.wav
}

const TAKE_COLORS = ['#7aa2f7', '#9ece6a', '#f7768e', '#e0af68', '#bb9af7', '#7dcfff']
function colorFor(takeId, takes) {
  return TAKE_COLORS[(takes.findIndex(t => t.takeId === takeId) + 1 + TAKE_COLORS.length) % TAKE_COLORS.length]
}

function renderTimeline(layout) {
  const wrap = q('#wb-timeline')
  wrap.replaceChildren()
  layout.items.forEach((item, index) => {
    const sameSourceOthers = layout.items.filter(other => other.id !== item.id &&
      effectiveRange(other).startFrame === item.startFrame && effectiveRange(other).endFrame === item.endFrame)
    const block = document.createElement('div')
    block.className = 'wb-block'
    block.dataset.itemId = item.id
    block.dataset.takeId = item.takeId
    block.style.flexGrow = Math.max(1, item.length)
    block.style.borderColor = colorFor(item.takeId, layout.takes)
    block.innerHTML = `
      <div class="wb-block-head"><b>${item.takeId}</b><span class="hint">${item.clip ?? item.clipId ?? '替换声'} · ${item.length}帧</span>${item.replacement ? '<em class="wb-replaced">已替换</em>' : ''}</div>
      <div class="wb-block-actions">
        <button type="button" data-act="left" title="左移">◀</button>
        <button type="button" data-act="right" title="右移">▶</button>
        <button type="button" data-act="swap" title="与另一次同源出场互换" ${sameSourceOthers.length ? '' : 'disabled'}>⇄同源</button>
        <button type="button" data-act="mid" title="从中点分段（同次出场）">✂中点</button>
        <button type="button" data-act="split" title="按所填局部帧分段">✂帧</button>
        <input type="number" class="wb-split-frame" placeholder="局部帧" title="出场内局部帧">
        <button type="button" data-act="replace">替换声</button>
        <input type="file" accept=".wav,audio/wav" hidden>
      </div>`
    block.querySelector('[data-act=left]').onclick = () => {
      if (index > 0) { [state.items[index - 1], state.items[index]] = [state.items[index], state.items[index - 1]]; invalidate(); refresh() }
    }
    block.querySelector('[data-act=right]').onclick = () => {
      if (index < state.items.length - 1) { [state.items[index + 1], state.items[index]] = [state.items[index], state.items[index + 1]]; invalidate(); refresh() }
    }
    block.querySelector('[data-act=swap]').onclick = () => {
      const other = sameSourceOthers[0]
      if (other) { swapBlocks(item.id, other.id); invalidate(); refresh() }
    }
    block.querySelector('[data-act=mid]').onclick = () => splitAt(item.id, Math.floor(item.length / 2))
    block.querySelector('[data-act=split]').onclick = () => {
      const frame = Number(block.querySelector('.wb-split-frame').value)
      if (Number.isFinite(frame)) splitAt(item.id, frame)
    }
    const fileInput = block.querySelector('input[type=file]')
    block.querySelector('[data-act=replace]').onclick = () => fileInput.click()
    fileInput.onchange = async event => {
      const file = event.target.files[0]
      event.target.value = ''
      if (!file) return
      try {
        note('读取替换声音…')
        const wav = await fromFile(file)
        const target = state.items.find(i => i.id === item.id)
        target.replacement = wav; target.wav = wav
        invalidate(); refresh(); note('已放入等长替换声音，可重新生成修复。')
      } catch (error) { note(error.message) }
    }
    wrap.append(block)

    if (index < layout.items.length - 1) {
      const hard = (state.hardCuts ?? []).includes(item.id) || item.hard === true || item.hardAfter === true
      const joint = document.createElement('button')
      joint.type = 'button'
      joint.className = `wb-joint${hard ? ' hard' : ' soft'}`
      joint.dataset.testid = 'joint'
      joint.dataset.after = item.id
      joint.setAttribute('aria-pressed', String(hard))
      joint.title = hard ? '硬切：两侧谱图与修复互不影响（点击改为软接）' : '软接：窗可跨过接头（点击标为硬切）'
      joint.textContent = hard ? '▮▮ 硬切' : '▯ 软接'
      joint.onclick = () => toggleHard(item.id)
      wrap.append(joint)
    }
  })
}

function renderTakeOptions(layout) {
  const select = q('#wb-region-form').elements.take
  const current = select.value
  select.replaceChildren(...layout.takes.map(t => {
    const o = document.createElement('option')
    o.value = t.takeId
    o.textContent = `${t.takeId}（${t.start.toFixed(3)}–${t.end.toFixed(3)} 秒）`
    return o
  }))
  if (current && layout.takes.some(t => t.takeId === current)) select.value = current
}

function renderRegions(layout) {
  const ul = q('#wb-regions')
  ul.replaceChildren(...layout.boxes.map(box => {
    const li = document.createElement('li')
    li.dataset.regionId = box.id
    li.dataset.takeId = box.takeId ?? ''
    li.innerHTML = `<span class="wb-swatch" style="background:${colorFor(box.takeId, layout.takes)}"></span>
      <code>${box.takeId ?? '全局'}</code>
      出场内 ${(box.start - (layout.takes.find(t => t.takeId === box.takeId)?.frameStart ?? 0) / rate).toFixed(3)}–
      ${(box.end - (layout.takes.find(t => t.takeId === box.takeId)?.frameStart ?? 0) / rate).toFixed(3)} 秒 ·
      全局 ${box.start.toFixed(3)}–${box.end.toFixed(3)} 秒 ·
      ${Math.round(box.low)}–${Math.round(box.high)} Hz · ${box.db} dB`
    const remove = document.createElement('button')
    remove.type = 'button'; remove.textContent = '移除'
    remove.onclick = () => { state.regions = state.regions.filter((r, i) => String(r.id ?? `r${i + 1}`) !== box.id); invalidate(); refresh() }
    li.append(remove)
    return li
  }))
}

function drawBoxes(boxes, duration) {
  const canvas = q('#wb-mask')
  const ctx = canvas.getContext('2d')
  const { width, height } = canvas
  ctx.clearRect(0, 0, width, height)
  if (!duration) return
  ctx.lineWidth = 2
  boxes.forEach(box => {
    const x = box.x0 * width, w = Math.max(2, (box.x1 - box.x0) * width)
    const y = (1 - box.high / (rate / 2)) * height
    const h = Math.max(2, (box.high - box.low) / (rate / 2) * height)
    ctx.strokeStyle = '#fff4ca'; ctx.fillStyle = '#fff4ca26'
    ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h)
  })
}

function refreshSpectrum() {
  if (view) spectrogram(q('#wb-plot'), view.spectrum)
}

function refresh() {
  state.size = Number(q('#wb-size').value)
  const layout = localLayout()
  q('#wb-max-time').textContent = `${layout.duration.toFixed(3)} 秒 / ${layout.totalFrames} 帧`
  renderClips(); renderTimeline(layout); renderTakeOptions(layout); renderRegions(layout); drawBoxes(layout.boxes, layout.duration)
  q('#wb-apply').disabled = !state.wav || !state.items.length || busy
  clearTimeout(inspectTimer)
  if (state.wav && state.items.length) inspectTimer = setTimeout(runInspect, 180)
}

function invalidate() {
  applied = null
  q('#wb-result').disabled = q('#wb-export').disabled = true
  q('#wb-original').setAttribute('aria-pressed', 'true')
  q('#wb-result').setAttribute('aria-pressed', 'false')
  q('#wb-metrics').textContent = ''
}

async function runInspect() {
  if (busy || !state.wav || !state.items.length) return
  busy = true
  try {
    view = await request('workbench-inspect', state)
    rate = view.rate
    // 用服务端权威帧区间回填本地条目，保证后续分段精确。
    if (Array.isArray(view.items)) {
      state.items = state.items.map((item, i) => {
        const server = view.items[i]
        return server ? { ...item, startFrame: server.startFrame, endFrame: server.endFrame, takeId: server.takeId } : item
      })
    }
    spectrogram(q('#wb-plot'), view.spectrum)
    drawBoxes(view.boxes ?? localLayout().boxes, view.duration)
    q('#wb-source-info').textContent = `源 ${view.sourceFrames} 帧 · 拼接 ${view.stitchedFrames} 帧 · ${view.rate} Hz · ${view.channels === 1 ? '单声道' : '双声道'}`
    q('#wb-apply').disabled = false
  } catch (error) { note(error.message) }
  finally { busy = false }
}

function show(which) {
  if (!applied && which === 'result') return
  const wav = which === 'result' ? applied.wav : (applied?.originalWav ?? view?.originalWav ?? view?.wav)
  if (!wav) return
  if (which === 'result' && applied?.spectrum) spectrogram(q('#wb-plot'), applied.spectrum)
  else if (view?.spectrum) spectrogram(q('#wb-plot'), (which === 'source' && applied?.originalSpectrum) || view.spectrum)
  const layout = localLayout()
  drawBoxes(layout.boxes, layout.duration)
  audio(wav, true)
  q('#wb-original').setAttribute('aria-pressed', String(which === 'source' || which === 'original'))
  q('#wb-result').setAttribute('aria-pressed', String(which === 'result'))
}

// ---- 拖选：定位到所在出场并以出场内秒建框 ----
function bindDrag() {
  const canvas = q('#wb-mask')
  let first = null
  const point = event => {
    const rect = canvas.getBoundingClientRect()
    return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)) }
  }
  canvas.onpointerdown = event => {
    if (event.button !== 0) return
    first = point(event); canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointercancel = () => { first = null }
  canvas.onpointerup = event => {
    if (!first) return
    const second = point(event)
    if (Math.abs(second.x - first.x) > 0.004 && Math.abs(second.y - first.y) > 0.004 && view) {
      const layout = localLayout()
      const duration = layout.duration
      const gStart = Math.min(first.x, second.x) * duration
      const gEnd = Math.max(first.x, second.x) * duration
      const take = layout.takes.find(t => gStart * rate >= t.frameStart && gStart * rate < t.frameEnd) ??
        layout.takes.find(t => gEnd * rate > t.frameStart && gStart * rate < t.frameEnd)
      const yHigh = 1 - Math.min(first.y, second.y)
      const yLow = 1 - Math.max(first.y, second.y)
      const region = {
        id: nextId('r'),
        takeId: take?.takeId ?? layout.takes[0]?.takeId,
        start: take ? Math.max(0, gStart - take.start) : gStart,
        end: take ? Math.min(take.end - take.start, gEnd - take.start) : gEnd,
        low: Math.round(yLow * rate / 2), high: Math.round(yHigh * rate / 2),
        db: Number(q('#wb-region-form').elements.db.value) || 20
      }
      if (region.end > region.start && region.high > region.low) {
        state.regions.push(region)
        const form = q('#wb-region-form')
        form.elements.take.value = region.takeId
        form.elements.start.value = region.start.toFixed(3)
        form.elements.end.value = region.end.toFixed(3)
        form.elements.low.value = region.low
        form.elements.high.value = region.high
        invalidate(); refresh()
      }
    }
    first = null
  }
}

// ---- 事件绑定 ----
q('#wb-demo').onclick = async () => {
  try {
    const d = await request('workbench-demo')
    state = { wav: d.wav, size: d.size ?? 512, clips: d.clips ?? [], items: d.items ?? [], hardCuts: d.hardCuts ?? [], regions: d.regions ?? [] }
    q('#wb-size').value = String(state.size)
    rate = d.rate ?? 16000
    applied = null
    q('#wb-result').disabled = q('#wb-export').disabled = true
    note('已载入 A-B-A：同一源段 A 出现两次，选框绑定后一次 a2；可点 ⇄同源 看选框跟随。')
    refresh()
  } catch (error) { note(error.message) }
}

q('#wb-file').onchange = event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (!file) return
  fromFile(file).then(async wav => {
    state.wav = wav
    const checked = await request('inspect', { wav, size: Number(q('#wb-size').value) })
    rate = checked.rate
    state.clips = [{ id: 'A', startFrame: 0, endFrame: checked.frames }]
    const id = nextId('t')
    state.items = [{ id, takeId: id, clip: 'A' }]
    state.regions = []; state.hardCuts = []
    applied = null
    note('已导入并生成整条初始片段，可按帧继续裁切。')
    refresh()
  }).catch(error => note(error.message))
}

q('#wb-cut').onclick = () => {
  const s = Number(q('#wb-cut-start').value), e = Number(q('#wb-cut-end').value)
  let id = q('#wb-cut-id').value.trim() || nextId('A')
  if (!(Number.isFinite(s) && Number.isFinite(e) && s >= 0 && e > s)) { note('请输入有效的开始/结束帧。'); return }
  if (state.clips.some(c => c.id === id)) id = `${id}-${++idSeq}`
  state.clips.push({ id, startFrame: Math.round(s), endFrame: Math.round(e) })
  q('#wb-cut-id').value = ''
  note(`已裁出源段 ${id}（${e - s} 帧），可重复放置。`)
  refresh()
}

q('#wb-size').onchange = () => { if (state.wav) { invalidate(); refresh() } }

q('#wb-region-form').onsubmit = event => {
  event.preventDefault()
  const form = event.currentTarget
  const region = {
    id: nextId('r'),
    takeId: form.elements.take.value,
    start: Number(form.elements.start.value), end: Number(form.elements.end.value),
    low: Number(form.elements.low.value), high: Number(form.elements.high.value),
    db: Number(form.elements.db.value)
  }
  if (!(region.end > region.start && region.high > region.low)) { note('请检查时段与频带。'); return }
  state.regions.push(region)
  invalidate(); refresh()
}

q('#wb-apply').onclick = async () => {
  if (busy) return
  busy = true; q('#workbench')?.setAttribute?.('aria-busy', 'true')
  try {
    applied = await request('workbench-repair', state)
    q('#wb-result').disabled = q('#wb-export').disabled = false
    q('#wb-metrics').textContent = `拼接 ${applied.stitchedFrames} 帧 · 处理 ${applied.editedWindows} 窗 · ` +
      applied.metrics.map((c, i) => `声道${i + 1} ΔRMS ${c.differenceRms.toFixed(5)}`).join('；')
    show('result')
    note('拼接修复已生成；原声与修复可对听，下载与“修复”试听是同一份 PCM16 WAV。')
  } catch (error) { note(error.message) }
  finally { busy = false; q('#workbench')?.removeAttribute?.('aria-busy') }
}
q('#wb-original').onclick = () => show('source')
q('#wb-result').onclick = () => show('result')
q('#wb-export').onclick = () => applied && download(wavBlob(applied.wav), 'workbench-restored.wav')

bindDrag()

// 程序化/浏览器自检钩子。
window.__workbench = {
  getState: () => JSON.parse(JSON.stringify(state)),
  getView: () => view,
  getApplied: () => applied,
  layout: () => localLayout(),
  actions: {
    loadDemo: () => q('#wb-demo').click(),
    swapSameSource: id => {
      const layout = localLayout()
      const item = layout.items.find(i => i.id === id || i.takeId === id)
      const other = layout.items.find(o => o.id !== item?.id && o.startFrame === item?.startFrame && o.endFrame === item?.endFrame)
      if (item && other) { swapBlocks(item.id, other.id); invalidate(); refresh() }
    },
    split: (id, frame) => splitAt(id, frame),
    hardCut: id => toggleHard(id),
    addRegion: region => { state.regions.push({ id: nextId('r'), ...region }); invalidate(); refresh() },
    repair: async () => q('#wb-apply').click(),
    inspect: runInspect
  }
}

// 首次进入自动打开 A-B-A 示例。
q('#wb-demo').click()
