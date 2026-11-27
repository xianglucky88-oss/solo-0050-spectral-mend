import { request } from './request.mjs'
import { download, wavBlob, fromFile } from './room-asset.mjs'

const q = selector => document.querySelector(selector)

const probeInput = q('#room-probe')
const captureInput = q('#room-capture')
const dryInput = q('#room-dry')
const markerInput = q('#room-marker')
const framesInput = q('#room-frames')
const exportButton = q('#room-export')
const proofButton = q('#room-proof')
const roomStatus = q('#room-status')
const proofStatus = q('#proof-status')

let probe, capture, dry, responseBlob, responseUrl, proofBlob, proofUrl, busy = false

const setRoomStatus = text => { roomStatus.textContent = text }
const setProofStatus = text => { proofStatus.textContent = text }

function refreshExportButton() {
  exportButton.disabled = busy || !probe || !capture ||
    markerInput.value.trim() === '' || framesInput.value.trim() === ''
}

function bindFile(input, onLoaded) {
  input.onchange = async event => {
    const file = event.target.files[0]
    event.target.value = ''
    if (!file) return
    try {
      onLoaded(await fromFile(file), null)
    } catch (error) {
      onLoaded(undefined, error)
    }
  }
}

async function run(task) {
  if (busy) return
  busy = true
  q('.room').setAttribute('aria-busy', 'true')
  refreshExportButton()
  try { await task() } finally {
    busy = false
    q('.room').setAttribute('aria-busy', 'false')
    refreshExportButton()
  }
}

async function blobToBase64(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

bindFile(probeInput, (base64, error) => {
  probe = base64
  setRoomStatus(error ? error.message : '已载入探测音。')
  refreshExportButton()
})
bindFile(captureInput, (base64, error) => {
  capture = base64
  setRoomStatus(error ? error.message : '已载入收音。')
  refreshExportButton()
})
bindFile(dryInput, (base64, error) => {
  dry = base64
  setProofStatus(error ? error.message : '已载入干声。')
})
for (const input of [markerInput, framesInput]) input.oninput = refreshExportButton

exportButton.onclick = () => run(async () => {
  setRoomStatus('正在提取并校验房间响应…')
  try {
    const marker = Number(markerInput.value), responseFrames = Number(framesInput.value)
    const result = await request('room-export', { probe, capture, marker, responseFrames })
    if (responseUrl) URL.revokeObjectURL(responseUrl)
    responseBlob = wavBlob(result.wav)
    responseUrl = URL.createObjectURL(responseBlob)
    q('#room-audio').src = responseUrl
    q('#room-download').disabled = false
    proofButton.disabled = false
    const detail = result.checks.map(check =>
      `声道 ${check.channel} 最大重放差 ${check.peakDifference} 码，首个超 2 码帧 ${check.firstAboveTwo < 0 ? '无' : check.firstAboveTwo}`)
      .join('；')
    setRoomStatus(`已交付 ${result.frames} 帧双声道房间响应（${result.rate} 赫兹）。${detail}。`)
  } catch (error) {
    setRoomStatus(error.message)
  }
})

q('#room-download').onclick = () => download(responseBlob, 'room-response.wav')

proofButton.onclick = () => run(async () => {
  if (!responseBlob) { setProofStatus('请先导出房间响应。'); return }
  if (!dry) { setProofStatus('请选择同采样率单声道干声。'); return }
  setProofStatus('正在卷积生成纯房间声…')
  try {
    const result = await request('room-proof', { response: await blobToBase64(responseBlob), dry })
    if (proofUrl) URL.revokeObjectURL(proofUrl)
    proofBlob = wavBlob(result.wav)
    proofUrl = URL.createObjectURL(proofBlob)
    q('#proof-audio').src = proofUrl
    q('#proof-download').disabled = false
    setProofStatus(`纯房间声已生成：${result.frames} 帧双声道，试听与下载为同一成品。`)
  } catch (error) {
    setProofStatus(error.message)
  }
})

q('#proof-download').onclick = () => download(proofBlob, 'room-proof.wav')
