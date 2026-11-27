import { request } from './request.mjs'
import { download } from './download.mjs'
import { fromFile, wavBlob } from './wave-asset.mjs'
import { audition } from './audition.mjs'

const q = selector => document.querySelector(selector)
const player = audition(q('audio'))
const note = text => { q('#status').textContent = text }

const emptySelection = () => ({
  0: { solos: [], program: null },
  1: { solos: [], program: null }
})

let source = null
let decoded = null
let selection = emptySelection()
let result = null
let busy = false

const seconds = value => value / decoded.rate
const toFrame = value => Math.round(value * decoded.rate)

/** 从 PCM WAV 的 Base64 直接读出采样与头信息，用于画波形。 */
function pcmViews(base64) {
  const bytes = Uint8Array.from(atob(base64), char => char.charCodeAt(0))
  const view = new DataView(bytes.buffer)
  const text = (offset, length) => String.fromCharCode(...bytes.subarray(offset, offset + length))
  let channels = 2, rate = 16000, dataOffset = -1, dataSize = 0
  let offset = 12
  while (offset + 8 <= bytes.length) {
    const name = text(offset, 4)
    const size = view.getUint32(offset + 4, true)
    if (name === 'fmt ') { channels = view.getUint16(offset + 10, true); rate = view.getUint32(offset + 12, true) }
    if (name === 'data') { dataOffset = offset + 8; dataSize = size; break }
    offset += 8 + size + (size % 2)
  }
  if (dataOffset < 0) throw new Error('WAV 缺少音频数据块。')
  const frames = dataSize / (2 * channels)
  const tracks = Array.from({ length: channels }, () => new Float32Array(frames))
  for (let i = 0; i < frames; i++) for (let c = 0; c < channels; c++)
    tracks[c][i] = view.getInt16(dataOffset + i * 2 * channels + c * 2, true) / 32768
  return { tracks, frames, rate, channels }
}

function drawStrip() {
  const strip = q('#strip')
  strip.replaceChildren(...[0, 1].map(channel => {
    const row = document.createElement('div')
    row.className = 'strip-row'
    const tag = document.createElement('span')
    tag.className = 'strip-tag'
    tag.textContent = channel === 0 ? '左' : '右'
    const canvas = document.createElement('canvas')
    canvas.width = 900; canvas.height = 64
    canvas.className = 'strip-canvas'
    canvas.dataset.channel = String(channel)
    row.append(tag, canvas)
    return row
  }))
  paint()
  for (const canvas of strip.querySelectorAll('canvas')) bindDrawing(canvas)
}

function paint() {
  for (const canvas of q('#strip').querySelectorAll('canvas')) {
    const channel = Number(canvas.dataset.channel)
    const ctx = canvas.getContext('2d'), { width, height } = canvas
    ctx.fillStyle = '#111225'; ctx.fillRect(0, 0, width, height)
    if (decoded) {
      const data = decoded.tracks[channel]
      const step = Math.max(1, Math.floor(data.length / width))
      ctx.strokeStyle = '#4e8fb0'; ctx.beginPath()
      for (let x = 0; x < width; x++) {
        let low = 0, high = 0
        for (let i = x * step; i < Math.min(data.length, (x + 1) * step); i++) {
          low = Math.min(low, data[i]); high = Math.max(high, data[i])
        }
        const mid = height / 2
        ctx.moveTo(x + .5, mid - high * mid * .9)
        ctx.lineTo(x + .5, mid - low * mid * .9)
      }
      ctx.stroke()
    }
    const state = selection[channel]
    const band = (from, to, fill, stroke) => {
      const x = from / decoded.frames * width, w = Math.max(1, (to - from) / decoded.frames * width)
      ctx.fillStyle = fill; ctx.fillRect(x, 0, w, height)
      ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.strokeRect(x + .5, .5, w - 1, height - 1)
    }
    state.solos.forEach(([from, to]) => band(from, to, '#f4b6a033', '#f4b6a0'))
    if (state.program) band(state.program[0], state.program[1], '#7ad9a833', '#7ad9a8')
  }
}

function bindDrawing(canvas) {
  let anchor
  canvas.onpointerdown = event => {
    if (event.button !== 0 || !decoded) return
    const box = canvas.getBoundingClientRect()
    anchor = clampFrame((event.clientX - box.left) / box.width * decoded.frames)
    canvas.setPointerCapture(event.pointerId)
  }
  canvas.onpointerup = event => {
    if (anchor === undefined || !decoded) return
    const box = canvas.getBoundingClientRect()
    const end = clampFrame((event.clientX - box.left) / box.width * decoded.frames)
    const from = Math.min(anchor, end), to = Math.max(anchor, end)
    anchor = undefined
    if (to - from >= 2) addRange(Number(canvas.dataset.channel), from, to)
  }
}

const clampFrame = value => Math.max(0, Math.min(decoded.frames, Math.round(value)))

function addRange(channel, from, to) {
  const state = selection[channel]
  if (q('#kind').value === 'program') {
    state.program = [from, to]
  } else {
    if (state.solos.length >= 3) { note('每路最多三段独奏。'); return }
    if (state.solos.some(([a, b]) => from < b && a < to)) { note('同一路的独奏不能重叠。'); return }
    state.solos = [...state.solos, [from, to]].sort((a, b) => a[0] - b[0])
  }
  invalidate()
  render()
}

function render() {
  paint()
  const rows = []
  for (const channel of [0, 1]) {
    const state = selection[channel]
    state.solos.forEach(([from, to], index) => rows.push(row(channel, 'solo',
      `独奏 ${index + 1}`, from, to, () => { state.solos.splice(index, 1) })))
    if (state.program) rows.push(row(channel, 'program', '待修节目', state.program[0], state.program[1],
      () => { state.program = null }))
  }
  q('#regions').replaceChildren(...rows)
  q('#apply').disabled = !ready()
}

function row(channel, kind, label, from, to, onRemove) {
  const item = document.createElement('li')
  item.className = `region ${kind}`
  const text = document.createElement('span')
  text.textContent = `${channel === 0 ? '左' : '右'}声道 · ${label} · ${seconds(from).toFixed(3)}–${seconds(to).toFixed(3)} 秒`
  const button = document.createElement('button')
  button.type = 'button'; button.textContent = '移除'
  button.onclick = () => { onRemove(); invalidate(); render() }
  item.append(text, button)
  return item
}

function ready() {
  // 至少各圈一段独奏并圈定待修节目即可提交；有声段数不足由服务端报缺证。
  const soloCounts = [0, 1].map(channel => selection[channel].solos.length)
  const programCount = [0, 1].filter(channel => selection[channel].program).length
  return soloCounts.every(count => count >= 1) && programCount === 1
}

function payload() {
  const toSegments = list => list.map(([from, to]) => ({ startFrame: from, endFrame: to }))
  const programChannel = selection[0].program ? 0 : 1
  const program = selection[programChannel].program
  return { wav: source, calibration: {
    solos: [toSegments(selection[0].solos), toSegments(selection[1].solos)],
    program: { startFrame: program[0], endFrame: program[1] } } }
}

function invalidate() {
  const hadResult = result !== null
  result = null
  q('#result').disabled = q('#export').disabled = true
  q('#issues').replaceChildren()
  q('#metrics').textContent = ''
  q('#original').setAttribute('aria-pressed', 'true')
  q('#result').setAttribute('aria-pressed', 'false')
  if (hadResult && source) player(source, true)
}

function showOriginal() {
  if (!source) return
  q('#original').setAttribute('aria-pressed', 'true')
  q('#result').setAttribute('aria-pressed', 'false')
  player(source, true)
}

function showResult() {
  if (!result) return
  q('#result').setAttribute('aria-pressed', 'true')
  q('#original').setAttribute('aria-pressed', 'false')
  player(result.wav, true)
}

function load(wav) {
  source = wav
  decoded = pcmViews(wav)
  selection = emptySelection()
  result = null
  q('#source-info').textContent = `${decoded.frames} 帧 · ${decoded.rate} 赫兹 · ${decoded.channels === 1 ? '单声道' : '双声道'}`
  q('#max-time').textContent = `${seconds(decoded.frames).toFixed(3)} 秒`
  const mono = decoded.channels === 1
  q('#hint').textContent = mono
    ? '串漏校准需要双声道节目；当前为单声道。'
    : '每路圈三段互不重叠的独奏，另圈一段与校准分开的待修节目。'
  q('#original').disabled = mono
  invalidate()
  drawStrip()
  if (!mono) showOriginal()
  note(mono ? '请导入双声道 PCM WAV。' : '拖动波形圈选独奏或待修节目。')
}

function showIssues(answer) {
  const list = q('#issues')
  list.replaceChildren(...answer.issues.map(issue => {
    const item = document.createElement('li')
    item.className = `issue ${issue.kind}`
    item.textContent = issue.message
    return item
  }))
  const adopted = Object.values(answer.directions).map(direction =>
    `${direction.id}：${direction.status === 'ok' ? `采用段 ${direction.adopted.map(index => index + 1).join('、')}` : direction.status}`)
  q('#metrics').textContent = adopted.join(' · ')
}

function showMetrics(answer) {
  const lines = answer.metrics.map(channel =>
    `${channel.channel === 0 ? '左' : '右'}声道节目峰值 ${channel.programPeakBefore.toFixed(3)} → ${channel.programPeakAfter.toFixed(3)}，去串 RMS ${channel.removedRms.toFixed(5)}，饱和 ${channel.saturation} 帧`)
  const relations = Object.values(answer.directions).map(direction =>
    `${direction.id} 采用段 ${direction.adopted.map(index => index + 1).join('、')}，增益 ${direction.gain.toFixed(3)}`)
  q('#metrics').textContent = [...lines, ...relations].join(' · ')
}

async function run(task) {
  if (busy) return
  busy = true
  try { await task() } catch (error) { note(error.message) }
  finally { busy = false }
}

q('#demo').onclick = () => run(async () => {
  const sample = await request('bleed-demo')
  load(sample.wav)
  for (const channel of [0, 1]) {
    selection[channel].solos = sample.calibration.solos[channel].map(segment => {
      const from = segment.startFrame ?? toFrame(segment.start)
      const to = segment.endFrame ?? toFrame(segment.end)
      return [from, to]
    })
  }
  const program = sample.calibration.program
  selection[0].program = [program.startFrame ?? toFrame(program.start), program.endFrame ?? toFrame(program.end)]
  render()
  note('已载入示例的独奏与待修节目，可校准。')
})

q('#file').onchange = async event => {
  const file = event.target.files[0]
  event.target.value = ''
  if (file) run(async () => load(await fromFile(file)))
}

q('#clear').onclick = () => {
  selection[Number(q('#channel').value)] = { solos: [], program: null }
  invalidate(); render()
}

q('#original').onclick = showOriginal
q('#result').onclick = showResult
q('#export').onclick = () => result && download(wavBlob(result.wav), 'crosstalk-restored.wav')

q('#apply').onclick = () => run(async () => {
  q('#apply').disabled = true
  try {
    const answer = await request('calibrate', payload())
    if (answer.status === 'ok') {
      result = answer
      q('#result').disabled = q('#export').disabled = false
      showResult()
      showMetrics(answer)
      q('#issues').replaceChildren()
      note('校准通过，已生成还原成品。')
    } else {
      result = null
      q('#result').disabled = q('#export').disabled = true
      showIssues(answer)
      note('未生成成品：请查看指出的方向与原因。')
    }
  } finally { q('#apply').disabled = !ready() }
})
