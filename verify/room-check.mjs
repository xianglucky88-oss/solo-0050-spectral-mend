// 房间响应导出/校样端到端验证（独立脚本，不属于服务模块）。
import { roomExport, roomProof } from '../server/room/session.mjs'
import { decodePcm } from '../server/audio/decode-pcm.mjs'
import { encode16 } from '../server/audio/encode16.mjs'
import { convolve16 } from '../server/audio/convolve.mjs'
import { quantizeCode } from '../server/audio/quantize.mjs'

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`PASS ${name}`)
  else { failures++; console.error(`FAIL ${name} ${detail}`) }
}
const expectReject = (name, fn, fragment) => {
  try { fn(); failures++; console.error(`FAIL ${name} 未拒绝`) }
  catch (error) {
    check(name, error.message.includes(fragment), error.message)
  }
}

const rate = 16000

// 构造宽带平坦谱探测音（房间测量形态：扫频/MLS/白噪类，非静音）与真实房间响应。
const probeFrames = 4000
const probe = new Int16Array(probeFrames)
let probeSeed = 99
for (let i = 0; i < probeFrames; i++) {
  probeSeed = (probeSeed * 1664525 + 1013904223) & 0x7fffffff
  const jitter = (probeSeed % 2000) - 1000
  const envelope = Math.min(1, i / 200, (probeFrames - i) / 400)
  probe[i] = quantizeCode(envelope * (8000 * ((i % 2) ? -1 : 1) + jitter * 0.3))
}
const responseFrames = 600
const trueResponse = [0, 1].map((channel) => {
  const h = new Int16Array(responseFrames)
  for (let i = 0; i < responseFrames; i++) {
    h[i] = quantizeCode(12000 * Math.exp(-i / (90 + channel * 30))
      * Math.sin(2 * Math.PI * (240 + channel * 60) * i / rate + channel))
  }
  return h
})

// 收音：标记前留 500 帧，之后按固定点卷积重放，再加一段尾巴。
const marker = 500
const segmentFrames = probeFrames + responseFrames - 1
const tail = 300
const captureFrames = marker + segmentFrames + tail
const capture = [0, 1].map(channel => {
  const track = new Int16Array(captureFrames)
  const replay = convolve16(probe, trueResponse[channel], segmentFrames)
  track.set(replay, marker)
  return track
})

const probeWav = encode16({ channels: 1, rate, codes: [probe] }).toString('base64')
const captureWav = encode16({ channels: 2, rate, codes: capture }).toString('base64')

// 1. 正常导出：逐帧重放差 ≤ 2，首个超 2 码帧一致。
const exported = roomExport({ probe: probeWav, capture: captureWav, marker, responseFrames })
const responsePcm = decodePcm(exported.wav, 4_000_000, { minFrames: 1 })
check('导出为双声道同采样率 PCM16', responsePcm.channels === 2 && responsePcm.rate === rate)
check('导出帧数等于指定响应帧数', responsePcm.frames === responseFrames)
let maxDiff = 0
for (let c = 0; c < 2; c++) for (let i = 0; i < responseFrames; i++) {
  maxDiff = Math.max(maxDiff, Math.abs(responsePcm.codes[c][i] - trueResponse[c][i]))
}
// 规格只要求重放逐帧差 ≤2，响应本身因量化可与真实响应有更大差异。
check('提取响应与真实响应码差在量化合理范围', maxDiff <= 8, `maxDiff=${maxDiff}`)
check('校验报告最大差不超过 2 码', exported.checks.every(c => c.peakDifference <= 2))

// 2. 直接用导出件重放，核对标记起完整尾部（服务端已校验，这里独立复核规则）。
for (let c = 0; c < 2; c++) {
  const replay = convolve16(probe, responsePcm.codes[c], segmentFrames)
  let localMax = 0, firstReplay = -1, firstCapture = -1
  for (let i = 0; i < segmentFrames; i++) {
    localMax = Math.max(localMax, Math.abs(replay[i] - capture[c][marker + i]))
    if (firstReplay < 0 && Math.abs(replay[i]) > 2) firstReplay = i
    if (firstCapture < 0 && Math.abs(capture[c][marker + i]) > 2) firstCapture = i
  }
  check(`声道 ${c + 1} 逐帧差 ≤ 2`, localMax <= 2, `localMax=${localMax}`)
  check(`声道 ${c + 1} 首个超 2 码帧一致`, firstReplay === firstCapture,
    `${firstReplay} vs ${firstCapture}`)
}

// 3. 重导同一响应：成品逐帧相同。
const reExported = roomExport({ probe: probeWav, capture: captureWav, marker, responseFrames })
check('重导同一响应逐帧相同', reExported.wav === exported.wav)

// 4. 干声校样：同采样率单声道，输出双声道、保留完整尾部，且确定性一致。
const dryFrames = 2000
const dry = new Int16Array(dryFrames)
for (let i = 0; i < dryFrames; i++) {
  dry[i] = quantizeCode(8000 * Math.sin(2 * Math.PI * 200 * i / rate) * Math.min(1, i / 100))
}
const dryWav = encode16({ channels: 1, rate, codes: [dry] }).toString('base64')
const proof = roomProof({ response: exported.wav, dry: dryWav })
const proofAgain = roomProof({ response: reExported.wav, dry: dryWav })
check('两次校样逐帧相同', proof.wav === proofAgain.wav)
const proofPcm = decodePcm(proof.wav, 4_000_000, { minFrames: 1 })
check('校样为双声道且保留完整尾部', proofPcm.channels === 2 &&
  proofPcm.frames === dryFrames + responseFrames - 1)
for (let c = 0; c < 2; c++) {
  const expected = convolve16(dry, responsePcm.codes[c], proofPcm.frames)
  let same = true
  for (let i = 0; i < expected.length; i++) if (expected[i] !== proofPcm.codes[c][i]) same = false
  check(`校样声道 ${c + 1} 与固定点卷积逐帧相同`, same)
}

// 5. 固定点规则：半码远离零、超幅裁切。
check('正半码远离零', quantizeCode(0.5) === 1)
check('负半码远离零', quantizeCode(-0.5) === -1)
check('超幅上限裁切', quantizeCode(40000) === 32767)
check('超幅下限裁切', quantizeCode(-40000) === -32768)
check('最近码舍入', quantizeCode(2.4) === 2 && quantizeCode(2.6) === 3)

// 6. 拒绝路径。
const silentWav = encode16({ channels: 1, rate, codes: [new Int16Array(probeFrames)] }).toString('base64')
expectReject('静音探测音拒绝', () => roomExport({ probe: silentWav, capture: captureWav, marker, responseFrames }), '静音')

const stereoProbe = encode16({ channels: 2, rate, codes: [probe, probe] }).toString('base64')
expectReject('非单声道探测音拒绝', () => roomExport({ probe: stereoProbe, capture: captureWav, marker, responseFrames }), '单声道')

const monoCapture = encode16({ channels: 1, rate, codes: [capture[0]] }).toString('base64')
expectReject('非双声道收音拒绝', () => roomExport({ probe: probeWav, capture: monoCapture, marker, responseFrames }), '双声道')

const rate8k = encode16({ channels: 1, rate: 8000, codes: [new Int16Array(probeFrames).fill(100)] }).toString('base64')
expectReject('采样率不一致拒绝', () => roomExport({ probe: rate8k, capture: captureWav, marker, responseFrames }), '同一采样率')

// 收音缺尾：标记太靠后，自标记起无法容纳探测音与响应的完整尾部。
const lateMarker = captureFrames - (probeFrames + responseFrames - 1) + 10
expectReject('收音缺尾拒绝',
  () => roomExport({ probe: probeWav, capture: captureWav, marker: lateMarker, responseFrames }), '缺尾')

// 响应帧数过长同样属于收音缺尾。
expectReject('响应过长收音缺尾拒绝',
  () => roomExport({ probe: probeWav, capture: captureWav, marker, responseFrames: responseFrames + tail + 50 }), '缺尾')

// 指定长度无合格响应：用不相关的收音（噪声替换一路），制造不匹配。
const badCapture = capture.map(track => Int16Array.from(track))
for (let i = marker; i < marker + segmentFrames; i++) badCapture[1][i] = (i * 257 % 6000) - 3000
const badWav = encode16({ channels: 2, rate, codes: badCapture }).toString('base64')
expectReject('无合格响应拒绝',
  () => roomExport({ probe: probeWav, capture: badWav, marker, responseFrames }), '无合格响应')

// 校样采样率不一致拒绝。
const dry8k = encode16({ channels: 1, rate: 8000, codes: [new Int16Array(dryFrames).fill(100)] }).toString('base64')
expectReject('校样采样率不一致拒绝', () => roomProof({ response: exported.wav, dry: dry8k }), '同一采样率')

console.log(failures ? `\n${failures} 项失败` : '\n全部通过')
process.exit(failures ? 1 : 0)
