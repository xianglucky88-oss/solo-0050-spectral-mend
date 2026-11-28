// 工作台 API 客户端。长录音以二进制 WAV 流式上传，服务端落临时文件，
// 后续谱图、试听、导出都凭 token 分块请求，浏览器不缓存整段音频。
const ROOT = '/api/spectral-mend'

async function json(response) {
  if (!response.ok) {
    let message = `请求失败（${response.status}）`
    try { message = (await response.json()).error || message } catch { /* 保留默认 */ }
    throw new Error(message)
  }
  return response.json()
}

export function fetchDemo() {
  return fetch(`${ROOT}/demo`).then(json)
}

export async function openWav(blob) {
  const response = await fetch(`${ROOT}/open`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: blob
  })
  return json(response)
}

export function fetchView(token, size, viewStart, viewEnd) {
  const q = new URLSearchParams({ token, size: String(size),
    viewStart: String(viewStart), viewEnd: String(viewEnd) })
  return fetch(`${ROOT}/view?${q}`).then(json)
}

export function fetchAudition(token, size, range, regions) {
  const q = new URLSearchParams({ token, size: String(size),
    start: String(range.start), end: String(range.end), regions: JSON.stringify(regions) })
  return fetch(`${ROOT}/audition?${q}`).then(json)
}

export async function fetchGenerate(token, size, regions) {
  const q = new URLSearchParams({ token, size: String(size), regions: JSON.stringify(regions) })
  const response = await fetch(`${ROOT}/generate?${q}`)
  if (!response.ok) {
    let message = `生成失败（${response.status}）`
    try { message = (await response.json()).error || message } catch { /* 保留默认 */ }
    throw new Error(message)
  }
  return response.blob()
}
