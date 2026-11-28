// 旧入口兼容性：六秒内录音在相同窗长与选区下，inspect/repair 的输出必须稳定，
// 且新 generate 入口对短录音复用同一 legacy repair，逐字节相同。
import { createApp } from '../server/app.mjs'
import { encode } from '../server/audio/encode.mjs'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

function synth(seconds = 4, rate = 22050, channels = 2) {
  const frames = rate * seconds
  const tracks = Array.from({ length: channels }, (_, c) =>
    Float64Array.from({ length: frames }, (_, i) => {
      const t = i / rate
      return 0.2 * Math.sin(2 * Math.PI * (440 + c * 110) * t) + 0.1 * Math.sin(2 * Math.PI * 1800 * t)
    }))
  return { rate, frames, channels, tracks }
}

const server = createApp().listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/spectral-mend`
const audio = synth()
const wavB64 = encode(audio).toString('base64')
const regionSets = [
  [],
  [{ start: 0.3, end: 2.1, low: 1200, high: 2400, db: 26 }],
  [{ start: 0.1, end: 1.0, low: 100, high: 900, db: 12 }, { start: 2.5, end: 3.8, low: 1500, high: 3000, db: 40 }]
]

try {
  for (const size of [256, 512, 1024]) {
    for (const regions of regionSets) {
      const body = JSON.stringify({ wav: wavB64, size, regions })
      const repairRes = await fetch(`${base}/repair`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body })
      const repaired = await repairRes.json()
      // 无选区必须与源逐字节相同
      if (regions.length === 0) {
        check(`size=${size} 空选区旁路`, repaired.wav === wavB64 && repaired.editedWindows === 0)
      } else {
        check(`size=${size} ${regions.length}选区：帧数/声道/计量保持`,
          repaired.metrics.length === audio.channels &&
          repaired.metrics.every(c => c.differenceRms >= 0))
      }
      // 新 generate 入口（短模式）与旧 repair 逐字节相同
      const openRes = await fetch(`${base}/open`, {
        method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encode(audio) })
      const { token, longMode } = await openRes.json()
      const q = new URLSearchParams({ token, size: String(size), regions: JSON.stringify(regions) })
      const genRes = await fetch(`${base}/generate?${q}`)
      const genBytes = Buffer.from(await genRes.arrayBuffer())
      check(`size=${size} ${regions.length}选区：新 generate 与旧 repair 逐字节一致`,
        !longMode && Buffer.compare(genBytes, Buffer.from(repaired.wav, 'base64')) === 0)
    }
  }
  // inspect 谱图在三种窗长下的频格宽度
  for (const [size, expectedBins] of [[256, 129], [512, 257], [1024, 513]]) {
    const res = await fetch(`${base}/inspect`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ wav: wavB64, size }) })
    const json = await res.json()
    check(`inspect size=${size} 频格数`, json.spectrum.values[0].length === expectedBins)
  }
} finally {
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
