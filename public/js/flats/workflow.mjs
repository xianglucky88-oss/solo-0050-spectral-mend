// 平顶检查 / 选定修复对象 / 跳转试听 / 生成等长成品的前端工作流。
import { request } from '../request.mjs'
import { wavBlob, fromFile } from '../wave-asset.mjs'
import { download } from '../download.mjs'

const q = (selector, root = document) => root.querySelector(selector)
const qa = (selector, root = document) => [...root.querySelectorAll(selector)]

const root = q('#flattop-lab')
if (root) {
  const els = {
    file: q('#flat-file', root),
    demo: q('#flat-demo', root),
    start: q('#circle-start', root),
    end: q('#circle-end', root),
    scanCircle: q('#scan-circle', root),
    scanAll: q('#scan-all', root),
    selectAll: q('#select-all-flats', root),
    repair: q('#repair-selected', root),
    status: q('#flat-status', root),
    panels: q('#channel-panels', root),
    waves: q('#waveforms', root),
    original: q('#flat-original', root),
    result: q('#flat-result', root),
    audio: q('#flat-audio', root),
    download: q('#flat-download', root),
    info: q('#flat-product-info', root)
  }

  let sourceWav = null
  let scanView = null
  let product = null
  let selectedIds = new Set()
  let version = 'source'
  let url = null
  let resumeAt = null

  const note = text => { els.status.textContent = text }
  const fmtRange = (a, b) => `${a.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')}–${b.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} 秒`
  const clipTime = (clip, rate) => ({ start: clip.startSample / rate, end: (clip.endSample + 1) / rate })

  function setAudio(wav, { play = false, at = null } = {}) {
    if (url) URL.revokeObjectURL(url)
    url = URL.createObjectURL(wavBlob(wav))
    els.audio.src = url
    const seek = at ?? resumeAt
    const applySeek = () => {
      if (seek !== null && Number.isFinite(seek)) {
        els.audio.currentTime = Math.min(seek, els.audio.duration || seek)
      }
      if (play) els.audio.play().catch(() => {})
    }
    els.audio.addEventListener('loadedmetadata', applySeek, { once: true })
    if (els.audio.readyState >= 1) applySeek()
  }

  els.audio.addEventListener('play', () => { resumeAt = els.audio.currentTime })
  els.audio.addEventListener('timeupdate', () => { if (!els.audio.paused) resumeAt = els.audio.currentTime })

  function syncVersionButtons() {
    els.original.setAttribute('aria-pressed', String(version === 'source'))
    els.result.setAttribute('aria-pressed', String(version === 'product'))
  }

  function showVersion(next, { jumpTo = null, play = false } = {}) {
    if (next === 'product' && !product) return
    const keep = jumpTo ?? (els.audio.readyState > 0 ? els.audio.currentTime : resumeAt)
    resumeAt = keep
    version = next
    setAudio(next === 'product' ? product.wav : sourceWav, { play, at: jumpTo ?? keep })
    syncVersionButtons()
    drawWaveforms()
  }

  function clipRow(clip, rate, { evidence = false, transient = false } = {}) {
    const li = document.createElement('li')
    li.className = transient ? 'transient-item' : evidence ? 'evidence-item' : 'clip-object'
    li.dataset.clipId = clip.id
    li.dataset.channel = String(clip.channel)
    li.dataset.startSample = String(clip.startSample)
    li.dataset.endSample = String(clip.endSample)
    const time = clipTime(clip, rate)

    if (!evidence && !transient) {
      const label = document.createElement('label')
      const checkbox = document.createElement('input')
      checkbox.type = 'checkbox'
      checkbox.className = 'pick'
      checkbox.dataset.clipId = clip.id
      checkbox.checked = selectedIds.has(clip.id)
      checkbox.setAttribute('aria-label', `选定修复对象 ${clip.id}`)
      checkbox.addEventListener('change', () => {
        if (checkbox.checked) selectedIds.add(clip.id)
        else selectedIds.delete(clip.id)
        syncSelectionControls()
      })
      const text = document.createElement('span')
      text.className = 'clip-text'
      text.textContent = `平顶 ${fmtRange(time.start, time.end)} · ${clip.length} 样点 · 削平幅度 ${clip.amplitude}`
      label.append(checkbox, text)
      li.append(label)
    } else {
      const text = document.createElement('span')
      text.className = 'clip-text'
      if (evidence) {
        text.textContent = `边界平顶 ${fmtRange(time.start, time.end)} · ${clip.length} 样点 · 缺一侧有效波形，不予补峰`
      } else {
        text.textContent = `满幅瞬态 ${time.start.toFixed(4)} 秒 · 单个满幅样点，不算平顶`
      }
      li.append(text)
    }

    const jump = document.createElement('button')
    jump.type = 'button'
    jump.className = 'jump'
    jump.textContent = '跳转试听'
    jump.dataset.time = String(time.start)
    jump.addEventListener('click', () => {
      // 选对象阶段默认听原声；若已生成成品，则在当前版本中跳转对比。
      const wav = version === 'product' && product ? product.wav : sourceWav
      if (version !== 'product') {
        version = 'source'
        syncVersionButtons()
      }
      setAudio(wav, { play: true, at: Math.max(0, time.start - 0.03) })
      note(`已跳转到声道 ${clip.channel + 1} 的 ${time.start.toFixed(3)} 秒处试听。`)
    })
    li.append(jump)
    return li
  }

  function renderPanels() {
    els.panels.replaceChildren()
    if (!scanView) return
    scanView.channels.forEach(report => {
      const rate = report.rate
      const section = document.createElement('section')
      section.className = 'channel-panel'
      section.dataset.channel = String(report.channel)
      const heading = document.createElement('h3')
      heading.textContent = `声道 ${report.channel + 1}`
      section.append(heading)

      const repairable = document.createElement('div')
      repairable.className = 'clip-group repairable'
      const h1 = document.createElement('h4')
      h1.textContent = `可补的平顶（${report.repairable.length}）`
      const ul1 = document.createElement('ul')
      ul1.className = 'clip-list repairable-list'
      report.repairable.forEach(clip => ul1.append(clipRow(clip, rate)))
      if (!report.repairable.length) {
        const empty = document.createElement('li')
        empty.className = 'empty'
        empty.textContent = '本时段没有两侧证据齐全的平顶。'
        ul1.append(empty)
      }
      repairable.append(h1, ul1)

      const evidence = document.createElement('div')
      evidence.className = 'clip-group evidence'
      const h2 = document.createElement('h4')
      h2.textContent = `证据不足（${report.evidence.length}）`
      const ul2 = document.createElement('ul')
      ul2.className = 'clip-list evidence-list'
      report.evidence.forEach(clip => ul2.append(clipRow(clip, rate, { evidence: true })))
      if (!report.evidence.length) {
        const empty = document.createElement('li')
        empty.className = 'empty'
        empty.textContent = '没有缺侧的边界平顶。'
        ul2.append(empty)
      }
      evidence.append(h2, ul2)

      const transients = document.createElement('div')
      transients.className = 'clip-group transients'
      const h3 = document.createElement('h4')
      h3.textContent = `另一声道满幅瞬态 / 非平顶（${report.transients.length}）`
      const ul3 = document.createElement('ul')
      ul3.className = 'clip-list transient-list'
      report.transients.forEach(clip => ul3.append(clipRow(clip, rate, { transient: true })))
      if (!report.transients.length) {
        const empty = document.createElement('li')
        empty.className = 'empty'
        empty.textContent = '没有单样点满幅瞬态。'
        ul3.append(empty)
      }
      transients.append(h3, ul3)

      section.append(repairable, evidence, transients)
      els.panels.append(section)
    })
    syncSelectionControls()
  }

  function syncSelectionControls() {
    const count = selectedIds.size
    els.repair.disabled = count === 0 || !sourceWav
    els.repair.textContent = count ? `修复选中的 ${count} 个对象并生成成品` : '修复选中对象并生成成品'
    const visiblePicks = qa('.pick', els.panels)
    const allVisible = visiblePicks.length > 0 && visiblePicks.every(cb => cb.checked)
    els.selectAll.checked = allVisible
    els.selectAll.indeterminate = !allVisible && visiblePicks.some(cb => cb.checked)
  }

  function drawWaveforms() {
    els.waves.replaceChildren()
    if (!scanView) return
    scanView.channels.forEach(report => {
      const wrap = document.createElement('div')
      wrap.className = 'wave-channel'
      wrap.dataset.channel = String(report.channel)
      const title = document.createElement('div')
      title.className = 'wave-title'
      title.textContent = `声道 ${report.channel + 1} · 拖动可圈出检查时段`
      const canvas = document.createElement('canvas')
      canvas.width = 920
      canvas.height = 130
      canvas.className = 'wave-canvas'
      canvas.setAttribute('aria-label', `声道 ${report.channel + 1} 波形与平顶标记，拖动圈选时段`)
      wrap.append(title, canvas)
      els.waves.append(wrap)
      drawOne(canvas, report)
      bindCircleDrag(canvas, report)
    })
  }

  function drawOne(canvas, report) {
    const ctx = canvas.getContext('2d')
    const { width, height } = canvas
    ctx.clearRect(0, 0, width, height)
    ctx.fillStyle = '#101326'
    ctx.fillRect(0, 0, width, height)
    const mid = height / 2
    const data = version === 'product' && product ? product.pcm[report.channel] : null
    const rate = report.rate
    const frames = report.frames

    // 波形
    ctx.strokeStyle = version === 'product' ? '#7fe0c3' : '#9fb4ff'
    ctx.lineWidth = 1
    ctx.beginPath()
    if (data) {
      for (let x = 0; x < width; x++) {
        const i0 = Math.floor(x / width * frames)
        const i1 = Math.max(i0 + 1, Math.floor((x + 1) / width * frames))
        let hi = 0
        for (let i = i0; i < i1; i++) hi = Math.max(hi, Math.abs(data[i] || 0))
        const y = mid - hi / 32768 * (height / 2 - 6)
        ctx.moveTo(x + .5, mid); ctx.lineTo(x + .5, y)
        ctx.moveTo(x + .5, mid); ctx.lineTo(x + .5, mid + hi / 32768 * (height / 2 - 6))
      }
      ctx.stroke()
    } else if (report.waveform) {
      const { min, max, buckets } = report.waveform
      for (let x = 0; x < width; x++) {
        const b = Math.min(buckets - 1, Math.floor(x / width * buckets))
        const y1 = mid - max[b] / 32768 * (height / 2 - 6)
        const y2 = mid - min[b] / 32768 * (height / 2 - 6)
        ctx.fillStyle = 'rgba(159,180,255,.75)'
        ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1))
      }
    }
    // 中线
    ctx.strokeStyle = '#2a2f55'
    ctx.beginPath(); ctx.moveTo(0, mid); ctx.lineTo(width, mid); ctx.stroke()

    const xOfSample = sample => sample / frames * width
    // 平顶整段标记
    for (const clip of report.clips) {
      const x = xOfSample(clip.startSample)
      const w = Math.max(2, xOfSample(clip.endSample + 1) - x)
      const picked = selectedIds.has(clip.id)
      ctx.fillStyle = clip.repairable
        ? (picked ? 'rgba(255,209,102,.45)' : 'rgba(255,209,102,.22)')
        : 'rgba(255,107,107,.18)'
      ctx.fillRect(x, 4, w, height - 8)
      ctx.strokeStyle = clip.repairable ? '#ffd166' : '#ff6b6b'
      ctx.lineWidth = picked ? 2 : 1
      ctx.strokeRect(x + .5, 4.5, w - 1, height - 9)
    }
    // 满幅瞬态
    ctx.fillStyle = '#c792ea'
    for (const spike of report.transients) {
      const x = xOfSample(spike.startSample)
      ctx.fillRect(x - 1, 6, 2, height - 12)
    }
    // 圈选时段
    const start = Number(els.start.value), end = Number(els.end.value)
    if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
      const x1 = start * rate / frames * width
      const x2 = end * rate / frames * width
      ctx.fillStyle = 'rgba(127,224,195,.10)'
      ctx.fillRect(x1, 0, x2 - x1, height)
      ctx.strokeStyle = '#7fe0c3'
      ctx.setLineDash([5, 4]); ctx.lineWidth = 1.5
      ctx.strokeRect(x1 + .5, .5, Math.max(1, x2 - x1), height - 1)
      ctx.setLineDash([])
    }
  }

  let dragStart = null
  function bindCircleDrag(canvas, report) {
    canvas.onpointerdown = event => {
      const box = canvas.getBoundingClientRect()
      dragStart = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
      canvas.setPointerCapture(event.pointerId)
    }
    const finish = event => {
      if (dragStart === null) return
      const box = canvas.getBoundingClientRect()
      const x = Math.max(0, Math.min(1, (event.clientX - box.left) / box.width))
      const a = Math.min(dragStart, x), b = Math.max(dragStart, x)
      dragStart = null
      if (b - a < 0.004) return
      els.start.value = (a * scanView.duration).toFixed(5)
      els.end.value = (b * scanView.duration).toFixed(5)
      runRangeScan()
    }
    canvas.onpointerup = finish
    canvas.onpointercancel = () => { dragStart = null }
  }

  async function loadWav(wav, circle = null) {
    sourceWav = wav
    product = null
    selectedIds = new Set()
    els.download.disabled = true
    els.result.disabled = true
    els.info.textContent = ''
    if (circle) {
      els.start.value = circle.start
      els.end.value = circle.end
    }
    version = 'source'
    syncVersionButtons()
    setAudio(sourceWav)
    await runRangeScan(true)
    note('原声已载入。拖圈检查时段，勾选可补平顶后生成成品。')
  }

  async function runRangeScan(whole = false) {
    if (!sourceWav) return
    try {
      const start = Number(els.start.value), end = Number(els.end.value)
      const payload = { wav: sourceWav }
      if (!whole && Number.isFinite(start) && Number.isFinite(end) && end > start) {
        payload.start = start
        payload.end = end
      }
      scanView = await request('clips', payload)
      // 若按区间扫描，用全量波形桶重绘需要完整 waveform：区间结果已带全文件波形桶。
      renderPanels()
      drawWaveforms()
      const rep = scanView.repairable.length, ev = scanView.evidence.length
      note(whole
        ? `全段识别到 ${scanView.clips.length} 个平顶：${rep} 个可补，${ev} 个证据不足；另有 ${scanView.transients.length} 个单样点满幅瞬态。`
        : `该检查时段内认出 ${rep} 个可补平顶整段、${ev} 个证据不足处。`)
    } catch (error) {
      note(error.message)
    }
  }

  els.scanCircle.addEventListener('click', () => runRangeScan(false))
  for (const input of [els.start, els.end]) {
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter') { event.preventDefault(); runRangeScan(false) }
    })
  }
  els.scanAll.addEventListener('click', () => {
    els.start.value = 0
    els.end.value = scanView ? scanView.duration.toFixed(5) : 3
    runRangeScan(true)
  })

  els.selectAll.addEventListener('change', () => {
    const picks = qa('.pick', els.panels)
    if (els.selectAll.checked) picks.forEach(cb => { cb.checked = true; selectedIds.add(cb.dataset.clipId) })
    else picks.forEach(cb => { cb.checked = false; selectedIds.delete(cb.dataset.clipId) })
    syncSelectionControls()
    drawWaveforms()
  })

  els.repair.addEventListener('click', async () => {
    if (!sourceWav || selectedIds.size === 0) return
    els.repair.disabled = true
    note('正在按工作台规则减半、舍入并补峰…')
    try {
      product = await request('declip', { wav: sourceWav, selections: [...selectedIds] })
      els.result.disabled = false
      els.download.disabled = false
      const peaks = product.results.map(r => `${r.id} 峰值 ${r.peak}${r.exceedsClipAmplitude ? ' > 原幅度' : ''}`).join('；')
      els.info.textContent = `成品与试听/下载为同一个 WAV：${product.frames} 帧，等长 ${product.wav.length} Base64 字符。${peaks}`
      version = 'product'
      syncVersionButtons()
      setAudio(product.wav, { at: resumeAt })
      drawWaveforms()
      note(`已补 ${product.results.length} 个选中对象；其余样点仅减半并按工作台规则舍入。可切换原声/成品，或直接下载。`)
    } catch (error) {
      note(error.message)
    } finally {
      syncSelectionControls()
    }
  })

  els.original.addEventListener('click', () => showVersion('source'))
  els.result.addEventListener('click', () => showVersion('product'))
  els.download.addEventListener('click', () => {
    if (product) download(wavBlob(product.wav), 'flat-top-finish.wav')
  })

  els.demo.addEventListener('click', async () => {
    try {
      const sample = await request('demo')
      await loadWav(sample.wav, sample.circle)
    } catch (error) { note(error.message) }
  })
  els.file.addEventListener('change', event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (file) fromFile(file).then(wav => loadWav(wav, { start: 0, end: 6 })).catch(error => note(error.message))
  })

  // 初始载入内置访谈录音。
  els.demo.click()
}
