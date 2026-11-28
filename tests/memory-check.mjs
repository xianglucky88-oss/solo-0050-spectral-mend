// 内存有界性验证：固定窗长、视区宽度、试听长度，逐步加长录音，
// 测量 view/audition/generate 的峰值堆增长，确认不随总帧数线性上升。
import { createApp } from '../server/app.mjs'
import { encode } from '../server/audio/encode.mjs'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

function synth(seconds, rate = 16000, channels = 2) {
  const frames = rate * seconds
  const tracks = Array.from({ length: channels }, (_, c) =>
    Float64Array.from({ length: frames }, (_, i) => 0.2 * Math.sin(2 * Math.PI * (300 + c * 90) * i / rate)))
  return { rate, frames, channels, tracks }
}

const mb = () => Math.round(process.memoryUsage().heapUsed / 10485.76) / 100
const server = createApp().listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/spectral-mend`
const regions = encodeURIComponent(JSON.stringify([{ start: 1, end: 4, low: 1500, high: 3000, db: 20 }]))

async function open(audio) {
  const res = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encode(audio) })
  return (await res.json()).token
}

async function exercise(token, seconds) {
  // 固定视区宽度 5 秒、试听 5 秒，与总时长无关
  await (await fetch(`${base}/view?token=${token}&size=512&viewStart=0&viewEnd=5`)).arrayBuffer()
  await (await fetch(`${base}/audition?token=${token}&size=512&start=0&end=5&regions=${regions}`)).arrayBuffer()
  const gen = await fetch(`${base}/generate?token=${token}&size=512&regions=${regions}`)
  // 流式下载：分块消费，不整体缓存
  const reader = gen.body.getReader()
  let chunks = 0
  while (!(await reader.read()).done) chunks++
  return chunks
}

try {
  global.gc?.()
  const readings = []
  for (const seconds of [10, 60, 150, 300]) {
    const token = await open(synth(seconds))
    global.gc?.()
    const before = mb()
    await exercise(token, seconds)
    global.gc?.()
    const after = mb()
    readings.push({ seconds, heap: after, delta: Math.round((after - before) * 100) / 100 })
    console.log(`  ${seconds}s 录音：练习后堆 ${after} MB（增量 ${after - before} MB）`)
  }
  // 300 秒录音的堆不应比 10 秒高出超过一个宽松阈值（流式路径下应接近常数）。
  const growth = readings[readings.length - 1].heap - readings[0].heap
  check('工作内存不随总帧数显著增长（300s vs 10s 堆差 < 25MB）', growth < 25,
    `增长 ${Math.round(growth * 100) / 100} MB`)

  // 视区谱图本身有界：不同总时长下返回列数恒定 ≤160
  const cols = []
  for (const seconds of [10, 150, 300]) {
    const token = await open(synth(seconds))
    const v = await (await fetch(`${base}/view?token=${token}&size=512&viewStart=2&viewEnd=7`)).json()
    cols.push(v.spectrum.values.length)
  }
  check('谱图列数在各时长下均有界', cols.every(c => c <= 160), cols.join('/'))
} finally {
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
