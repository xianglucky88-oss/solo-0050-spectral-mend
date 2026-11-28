// 端到端 HTTP 验证：启动真实服务，用 fetch 走完整工作流。
import { createApp } from '../server/app.mjs'
import { encode } from '../server/audio/encode.mjs'

let failures = 0
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`)
  if (!ok) failures++
}

function synth({ rate = 16000, seconds = 30, channels = 2, seed = 3 }) {
  const frames = rate * seconds
  let state = seed
  const rand = () => { state = (state * 1103515245 + 12345) & 0x7fffffff; return state / 0x7fffffff }
  const tracks = Array.from({ length: channels }, (_, c) => Float64Array.from({ length: frames }, (_, i) => {
    const t = i / rate
    return Math.max(-1, Math.min(1, 0.2 * Math.sin(2 * Math.PI * (300 + c * 90) * t)
      + 0.15 * Math.sin(2 * Math.PI * 2400 * t) + 0.02 * (rand() - 0.5)))
  }))
  return { rate, frames, channels, tracks }
}

const server = createApp().listen(0, '127.0.0.1')
await new Promise(r => server.once('listening', r))
const port = server.address().port
const base = `http://127.0.0.1:${port}/api/spectral-mend`

async function postWav(path, audio) {
  const res = await fetch(`${base}/${path}`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: encode(audio) })
  return { status: res.status, json: await res.json() }
}

try {
  // 1. demo 旧入口
  const demo = await (await fetch(`${base}/demo`)).json()
  check('demo 返回内置录音', typeof demo.wav === 'string' && demo.region)

  // 2. 旧 inspect/repair 入口仍工作且形状不变
  const legacyInspect = await (await fetch(`${base}/inspect`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wav: demo.wav, size: 512 })
  })).json()
  check('旧 inspect：谱图 160 列上限', legacyInspect.spectrum.values.length <= 160)
  const legacyRepair = await (await fetch(`${base}/repair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wav: demo.wav, size: 512, regions: [demo.region] })
  })).json()
  check('旧 repair：返回 WAV 与计量', typeof legacyRepair.wav === 'string' && legacyRepair.metrics.length === 2)

  // 3. 打开长录音（30 秒）
  const long = synth({ seconds: 30 })
  const opened = await postWav('open', long)
  check('open 长录音：返回 token 与长模式', opened.status === 200 && opened.json.longMode === true && opened.json.token,
    `status=${opened.status}`)
  const token = opened.json.token

  // 4. 视区谱图：只请求 5-10 秒
  const view = await (await fetch(`${base}/view?token=${token}&size=512&viewStart=5&viewEnd=10`)).json()
  check('view：列数有界（≤160）且带视区坐标', view.spectrum.values.length <= 160 &&
    view.spectrum.viewStart === 5 && view.spectrum.viewEnd === 10)
  check('view：频格数随窗长', view.spectrum.values[0].length === 257)

  // 5. 平移/缩放后换视区，返回不同数据但坐标自洽
  const view2 = await (await fetch(`${base}/view?token=${token}&size=512&viewStart=20&viewEnd=22`)).json()
  check('view：缩放视区列数仍有界', view2.spectrum.values.length <= 160 && view2.spectrum.viewStart === 20)

  // 6. 试听：原声与修复声，最多十秒
  const regions = encodeURIComponent(JSON.stringify([{ start: 6, end: 9, low: 2000, high: 2800, db: 20 }]))
  const audition = await (await fetch(`${base}/audition?token=${token}&size=512&start=5&end=10&regions=${regions}`)).json()
  check('audition：返回成对原声/修复 WAV', audition.original && audition.repaired &&
    audition.original.length === audition.repaired.length)
  check('audition：帧数对应五秒', audition.frames === 5 * long.rate)

  // 7. 试听与下载在重叠帧逐样一致：取下载中同一区间比对
  const gen = await fetch(`${base}/generate?token=${token}&size=512&regions=${regions}`)
  check('generate：返回音频流', gen.ok && gen.headers.get('content-type') === 'audio/wav')
  const genBytes = Buffer.from(await gen.arrayBuffer())
  const repairedAud = Buffer.from(audition.repaired, 'base64')
  const skip = Math.round((audition.start - 0) * long.rate) * long.channels * 2
  const overlap = repairedAud.subarray(44)
  const same = overlap.equals(genBytes.subarray(44 + skip, 44 + skip + overlap.length))
  check('试听与下载重叠帧逐样一致', same)

  // 8. 无选区整件生成与源逐字节相同
  const bypass = await fetch(`${base}/generate?token=${token}&size=512&regions=%5B%5D`)
  const bypassBytes = Buffer.from(await bypass.arrayBuffer())
  check('无选区下载与源逐字节相同', Buffer.compare(bypassBytes, encode(long)) === 0)

  // 9. 短录音（3 秒）走新入口，下载与旧 repair 逐字节相同
  const short = synth({ seconds: 3, seed: 9 })
  const shortOpen = await postWav('open', short)
  check('open 短录音：标记为短模式', shortOpen.json.longMode === false)
  const shortRegions = encodeURIComponent(JSON.stringify([{ start: 0.5, end: 2, low: 1000, high: 3000, db: 18 }]))
  const shortGen = await fetch(`${base}/generate?token=${shortOpen.json.token}&size=512&regions=${shortRegions}`)
  const shortBytes = Buffer.from(await shortGen.arrayBuffer())
  const shortLegacy = await (await fetch(`${base}/repair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ wav: encode(short).toString('base64'), size: 512,
      regions: [{ start: 0.5, end: 2, low: 1000, high: 3000, db: 18 }] })
  })).json()
  check('短录音：新 generate 与旧 repair 逐字节相同',
    Buffer.compare(shortBytes, Buffer.from(shortLegacy.wav, 'base64')) === 0)

  // 10. 试听超过十秒被拒绝
  const tooLong = await fetch(`${base}/audition?token=${token}&size=512&start=0&end=11&regions=%5B%5D`)
  check('试听超十秒被拒绝', tooLong.status === 400)

  // 11. 选区超限被拒绝
  const tooMany = encodeURIComponent(JSON.stringify(Array.from({ length: 9 }, (_, i) =>
    ({ start: i, end: i + 0.5, low: 100, high: 200, db: 6 }))))
  const badRegions = await fetch(`${base}/generate?token=${token}&size=512&regions=${tooMany}`)
  check('超过 8 个选区被拒绝', badRegions.status === 400)

  // 12. 不完整文件（截在帧中间）提示并拒绝生成
  const full = encode(long)
  const truncated = Buffer.concat([full.subarray(0, 44), full.subarray(44, 44 + 1000 * long.channels * 2 + 3)])
  const tr = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: truncated })
  const trJson = await tr.json()
  check('截断文件：标记 complete=false', tr.status === 200 && trJson.complete === false)
  const trGen = await fetch(`${base}/generate?token=${trJson.token ?? 'none'}&size=512&regions=%5B%5D`)
  check('截断文件：拒绝生成', trGen.status === 400 || trGen.status === 404)

  // 13. 非法格式被拒绝
  const bad = await fetch(`${base}/open`, { method: 'POST', headers: { 'content-type': 'audio/wav' }, body: Buffer.from('not a wav') })
  check('非 WAV 数据被拒绝', bad.status === 400)

  // 14. 下载保留采样率/声道/帧数
  check('下载头部保留格式', genBytes.readUInt32LE(24) === long.rate &&
    genBytes.readUInt16LE(22) === long.channels &&
    (genBytes.length - 44) / (long.channels * 2) === long.frames)

} finally {
  server.close()
}
console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
