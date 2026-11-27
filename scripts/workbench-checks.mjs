// 工作台有界自检：逐条核对任务描述中的硬规则。
// 运行：node scripts/workbench-checks.mjs （失败以非零码退出）
import assert from 'node:assert/strict'
import { demo } from '../server/audio/demo.mjs'
import { decode } from '../server/audio/decode.mjs'
import {
  inspectWorkbench, repairWorkbench, workbenchDemo, MAX_WORKBENCH_SECONDS
} from '../server/workbench/session.mjs'
import {
  createState, cutClip, placeClip, swapAppearances, splitAppearance,
  setHardCut, replaceAudio, addRegion, isWorkbenchInput
} from '../server/workbench/index.mjs'
import { encode } from '../server/audio/encode.mjs'

let count = 0
const check = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`) }

const sample = demo()
const rate = 16000
const f = sec => Math.round(sec * rate)

// 构造一段不同的等长替换声音（双声道）。
function replacementWav(frames, freq = 660) {
  const tracks = [0, 1].map(ch => Float64Array.from({ length: frames }, (_, i) =>
    0.3 * Math.sin(2 * Math.PI * freq * i / rate) * (ch ? 0.8 : 1)))
  return encode({ tracks, rate, frames }).toString('base64')
}
function intSamples(base64) {
  const audio = decode(base64)
  return audio.tracks.map(t => Int16Array.from(t, x => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))))
}
function bench(over = {}) {
  return {
    wav: sample.wav, size: 512,
    clips: [
      { id: 'A', startFrame: f(0.2), endFrame: f(0.62) },
      { id: 'B', startFrame: f(0.86), endFrame: f(1.46) }
    ],
    items: [
      { id: 'a1', takeId: 'a1', clip: 'A' },
      { id: 'b1', takeId: 'b1', clip: 'B' },
      { id: 'a2', takeId: 'a2', clip: 'A' }
    ],
    ...over
  }
}
const lenA = f(0.62) - f(0.2), lenB = f(1.46) - f(0.86)
const totalABA = lenA + lenB + lenA

console.log('帧裁切 / 拼接 / 格式')
check('拼接帧数 = 各片段帧数之和，采样率与声道保留', () => {
  const r = inspectWorkbench(bench())
  assert.equal(r.frames, totalABA)
  assert.equal(r.stitchedFrames, totalABA)
  assert.equal(r.rate, 16000)
  assert.equal(r.channels, 2)
  assert.equal(r.spectrum.duration, totalABA / rate)
})

check('originalWav 按当前 A-B-A 顺序逐样拼接', () => {
  const r = inspectWorkbench(bench())
  const out = intSamples(r.originalWav)
  const src = decode(sample.wav).tracks.map(t => Int16Array.from(t, x => Math.round(x * 32768)))
  const ranges = [[f(0.2), f(0.62)], [f(0.86), f(1.46)], [f(0.2), f(0.62)]]
  let off = 0
  for (const [s, e] of ranges) {
    for (let i = 0; i < e - s; i++) for (let c = 0; c < 2; c++) {
      assert.equal(out[c][off + i], src[c][s + i], `frame ${off + i} ch${c}`)
    }
    off += e - s
  }
  assert.equal(off, totalABA)
})

console.log('出场身份与选框跟随')
check('选区绑定后一次 A：解析到右侧位置', () => {
  const state = bench({ regions: [{ id: 'box', takeId: 'a2', start: 0.06, end: 0.38, low: 200, high: 1000, db: 18 }] })
  const r = inspectWorkbench(state)
  const box = r.boxes.find(b => b.id === 'box')
  assert.ok(box)
  assert.equal(box.takeId, 'a2')
  assert.equal(box.startFrame, lenA + lenB + f(0.06))
  assert.equal(box.endFrame, lenA + lenB + f(0.38))
})

check('互换两次 A 后选框随原出场移动到左侧', () => {
  const withRegion = addRegion(createState(bench()),
    { id: 'box', takeId: 'a2', start: 0.06, end: 0.38, low: 200, high: 1000, db: 18 })
  const before = inspectWorkbench(withRegion)
  const beforeBox = before.boxes[0]
  assert.equal(beforeBox.startFrame, lenA + lenB + f(0.06))

  const swapped = swapAppearances(withRegion, 0, 2)
  assert.deepEqual(swapped.items.map(i => i.takeId), ['a2', 'b1', 'a1'])
  const after = inspectWorkbench(swapped)
  const box = after.boxes.find(b => b.id === 'box')
  assert.equal(box.takeId, 'a2')
  assert.equal(box.startFrame, f(0.06))
  assert.equal(box.endFrame, f(0.38))
  assert.notEqual(box.startFrame, beforeBox.startFrame)
})

check('互换后衰减能量从右 A 槽位移到左 A 槽位', () => {
  const region = { id: 'box', takeId: 'a2', start: 0.05, end: 0.4, low: 120, high: 1200, db: 28 }
  const s1 = bench({ regions: [region] })
  const s2 = swapAppearances(bench({ regions: [region] }), 0, 2)
  const w1 = intSamples(repairWorkbench(s1).wav)
  const w2 = intSamples(repairWorkbench(s2).wav)
  const orig = intSamples(inspectWorkbench(bench()).originalWav)
  const left = [0, lenA], right = [lenA + lenB, totalABA]
  const diffEnergy = (w, range) => {
    let e = 0
    for (let i = range[0]; i < range[1]; i++) for (let c = 0; c < 2; c++) e += (w[c][i] - orig[c][i]) ** 2
    return e
  }
  // 互换前改右侧；互换后绑定 a2 的框移到左侧，改左侧。
  assert.ok(diffEnergy(w1, right) > diffEnergy(w1, left) * 5)
  assert.ok(diffEnergy(w2, left) > diffEnergy(w2, right) * 5)
})

console.log('硬切隔离与等长替换不变性')
check('替换硬切一侧后，另一侧谱图读数与修复样点不变', () => {
  const framesX = f(0.5), framesY = f(0.55)
  const base = {
    wav: sample.wav,
    clips: [
      { id: 'X', startFrame: f(0.1), endFrame: f(0.1) + framesX },
      { id: 'Y', startFrame: f(1.6), endFrame: f(1.6) + framesY }
    ],
    items: [{ id: 'x', takeId: 'x', clip: 'X' }, { id: 'y', takeId: 'y', clip: 'Y' }],
    hardCuts: ['x'],
    regions: [{ id: 'ry', takeId: 'y', start: 0.05, end: 0.4, low: 300, high: 2600, db: 16 }]
  }
  const beforeI = inspectWorkbench(base)
  const beforeR = repairWorkbench(base)

  const changed = replaceAudio(base, 'x', replacementWav(framesX, 720))
  const afterI = inspectWorkbench(changed)
  const afterR = repairWorkbench(changed)

  const spanY0 = beforeI.spans.find(s => s.frameStart === framesX)
  const spanY1 = afterI.spans.find(s => s.frameStart === framesX)
  assert.ok(spanY0 && spanY1)
  assert.deepEqual(spanY1.spectrum.values, spanY0.spectrum.values)
  for (const t of [0.1, 0.25, 0.45]) for (const hz of [400, 1000, 1800]) {
    assert.deepEqual(afterI.readAt(framesX / rate + t, hz), beforeI.readAt(framesX / rate + t, hz))
  }
  const a = intSamples(beforeR.wav), b = intSamples(afterR.wav)
  for (let i = framesX; i < framesX + framesY; i++) for (let c = 0; c < 2; c++) {
    assert.equal(b[c][i], a[c][i], `Y repaired sample ${i - framesX} ch${c} changed`)
  }
  // 确认 X 一侧确实被替换，避免“两边都没算”的假通过。
  let xChanged = 0
  for (let i = 0; i < framesX; i++) for (let c = 0; c < 2; c++) if (a[c][i] !== b[c][i]) xChanged++
  assert.ok(xChanged > framesX, 'X side should differ after replacement')
})

console.log('同次出场内定位分段的透明性')
check('连续原声分段后，选框/谱图/修复 PCM 全部不变', () => {
  const state = {
    wav: sample.wav,
    clips: [{ id: 'A', startFrame: f(0.2), endFrame: f(0.9) }],
    items: [{ id: 't1', takeId: 't1', clip: 'A' }],
    regions: [{ id: 'box', takeId: 't1', start: 0.08, end: 0.62, low: 220, high: 2400, db: 22 }]
  }
  const split = splitAppearance(state, 't1', f(0.5), { relative: 'local' })
  assert.equal(split.items.length, 2)
  assert.equal(split.items[0].takeId, 't1')
  assert.equal(split.items[1].takeId, 't1')

  const i1 = inspectWorkbench(state), i2 = inspectWorkbench(split)
  assert.deepEqual(i2.boxes, i1.boxes)
  assert.deepEqual(i2.spectrum.values, i1.spectrum.values)
  assert.deepEqual(i2.spectrum.centers, i1.spectrum.centers)

  const r1 = repairWorkbench(state), r2 = repairWorkbench(split)
  assert.equal(r2.wav, r1.wav, 'repair PCM16 base64 must be identical')
})

console.log('衰减与硬切逐样保留')
check('被圈频带能量下降；隔硬切的未选跨度与原声逐样一致', () => {
  const xFrames = f(0.7), yFrames = f(0.7)
  const state = {
    wav: sample.wav,
    clips: [
      { id: 'X', startFrame: f(0.7), endFrame: f(0.7) + xFrames },
      { id: 'Y', startFrame: f(2.2), endFrame: f(2.2) + yFrames }
    ],
    items: [{ id: 'x', takeId: 'x', clip: 'X' }, { id: 'y', takeId: 'y', clip: 'Y' }],
    hardCuts: ['x'],
    regions: [{ id: 'hum', takeId: 'x', start: 0.05, end: 0.65, low: 1450, high: 1750, db: 30 }]
  }
  const before = inspectWorkbench(state)
  const after = repairWorkbench(state)
  const beforeRead = before.readAt(0.35, 1600)
  const afterRead = after.readAt(0.35, 1600)
  assert.ok(afterRead.db < beforeRead.db - 8,
    `expected attenuation, before=${beforeRead.db} after=${afterRead.db}`)

  const repaired = intSamples(after.wav)
  const original = intSamples(after.originalWav)
  for (let i = xFrames; i < xFrames + yFrames; i++) for (let c = 0; c < 2; c++) {
    assert.equal(repaired[c][i], original[c][i], `unselected across hard cut ${i - xFrames} must be untouched`)
  }
})

console.log('PCM16 WAV 契约')
check('试听与下载共用同一 Base64 PCM16 WAV，头部格式正确', () => {
  const r = repairWorkbench(bench({ regions: [{ takeId: 'a2', start: 0.05, end: 0.3, low: 300, high: 2000, db: 18 }] }))
  assert.equal(r.wav, r.repairedWav)
  assert.equal(r.wav, r.downloadWav)
  assert.equal(r.wav, r.auditionWav)
  const buf = Buffer.from(r.wav, 'base64')
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF')
  assert.equal(buf.toString('latin1', 8, 12), 'WAVE')
  assert.equal(buf.readUInt16LE(20), 1, 'PCM format')
  assert.equal(buf.readUInt16LE(22), 2, 'stereo channels')
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt16LE(34), 16, 'bits per sample')
  assert.equal(buf.readUInt32LE(40), totalABA * 4)
  const decoded = decode(r.wav)
  assert.equal(decoded.frames, totalABA)
})

check('内置 A-B-A 演示可直接检查与修复', () => {
  const d = workbenchDemo()
  assert.ok(isWorkbenchInput(d))
  const i = inspectWorkbench(d)
  assert.equal(i.items.length, 3)
  assert.equal(i.boxes[0].takeId, 'a2')
  const r = repairWorkbench(d)
  assert.ok(r.wav.length > 1000)
})

check('时长限制：超过 6 秒拼接被拒绝', () => {
  const long = {
    wav: sample.wav,
    items: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, startFrame: 0, endFrame: f(0.4) }))
  }
  assert.throws(() => inspectWorkbench(long), /时长/)
  assert.equal(MAX_WORKBENCH_SECONDS, 6)
})

console.log('状态操作器')
check('cut/place 生成可复用源段', () => {
  let s = createState({ wav: sample.wav })
  s = cutClip(s, { id: 'A', startFrame: 100, endFrame: 500 })
  s = placeClip(s, 'A', { id: 't1' })
  s = placeClip(s, 'A', { id: 't2' })
  assert.equal(s.items.length, 2)
  assert.equal(s.items[0].startFrame, 100)
  assert.notEqual(s.items[0].takeId, s.items[1].takeId)
})

console.log(`\n全部 ${count} 组工作台自检通过 ✅`)
