// 领域边界：六秒模式分界、五分钟上限、最小帧数、采样率/声道边界、试听十秒上限。
import { createApp } from '../server/app.mjs'
import { encode } from '../server/audio/encode.mjs'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

const make = (rate, seconds, channels = 2) => {
  const frames = Math.round(rate * seconds)
  const tracks = Array.from({ length: channels }, () =>
    Float64Array.from({ length: frames }, (_, i) => 0.1 * Math.sin(2 * Math.PI * 300 * i / rate)))
  return { rate, frames, channels, tracks }
}

const server = createApp().listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/spectral-mend`

async function open(audio) {
  const res = await fetch(`${base}/open`, {
    method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encode(audio) })
  return { status: res.status, json: await res.json() }
}

try {
  // 恰好 6 秒：短模式；6 秒 + 1 帧：长模式
  const atSix = await open(make(16000, 6))
  check('恰好 6 秒为短模式', atSix.json.longMode === false)
  const overSix = await open({ ...make(16000, 6), frames: 16000 * 6 + 1,
    tracks: [new Float64Array(16000 * 6 + 1), new Float64Array(16000 * 6 + 1)] })
  check('6 秒加 1 帧为长模式', overSix.json.longMode === true)

  // 恰好 5 分钟可打开
  const fiveMin = await open(make(16000, 300))
  check('五分钟录音可打开', fiveMin.status === 200 && fiveMin.json.complete)

  // 超过五分钟拒绝
  const tooLong = await open(make(16000, 300.5))
  check('超过五分钟拒绝', tooLong.status === 400, tooLong.json.error)

  // 采样率边界
  check('8 kHz 接受', (await open(make(8000, 5, 1))).status === 200)
  check('48 kHz 接受', (await open(make(48000, 5, 2))).status === 200)
  const badRate = await (async () => {
    const audio = make(16000, 2)
    const buf = encode(audio)
    buf.writeUInt32LE(11025, 24) // 篡改采样率为不支持值
    const res = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: buf })
    return res.status
  })()
  check('非 8–48k 拒绝', badRate === 400)

  // 最小帧数
  const tooShort = await (async () => {
    const audio = { rate: 16000, frames: 10, channels: 1, tracks: [new Float64Array(10)] }
    const res = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encode(audio) })
    return res.status
  })()
  check('少于 16 帧拒绝', tooShort === 400)

  // 试听恰好 10 秒接受，10 秒加一点拒绝
  const token = (await open(make(16000, 30))).json.token
  const okTen = await fetch(`${base}/audition?token=${token}&size=512&start=0&end=10&regions=%5B%5D`)
  check('试听恰好 10 秒接受', okTen.ok)
  const overTen = await fetch(`${base}/audition?token=${token}&size=512&start=0&end=10.5&regions=%5B%5D`)
  check('试听超 10 秒拒绝', overTen.status === 400)

  // 窗长非法值
  const badSize = await fetch(`${base}/view?token=${token}&size=128&viewStart=0&viewEnd=5`)
  check('非法窗长拒绝', badSize.status === 400)

  // 选区频带/时段越界拒绝
  const badRegion = encodeURIComponent(JSON.stringify([{ start: 0, end: 2, low: 100, high: 99999, db: 10 }]))
  const badBand = await fetch(`${base}/audition?token=${token}&size=512&start=0&end=2&regions=${badRegion}`)
  check('频带上限越界拒绝', badBand.status === 400)

  // 单声道长录音端到端
  const mono = await open(make(24000, 20, 1))
  check('单声道长录音打开', mono.json.channels === 1 && mono.json.longMode)
  const gen = await fetch(`${base}/generate?token=${mono.json.token}&size=512&regions=%5B%5D`)
  const bytes = Buffer.from(await gen.arrayBuffer())
  check('单声道导出帧数保持', (bytes.length - 44) / 2 === 24000 * 20 && bytes.readUInt16LE(22) === 1)
} finally {
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
