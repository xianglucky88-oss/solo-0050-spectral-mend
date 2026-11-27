import test from 'node:test'
import assert from 'node:assert/strict'
import { demo } from '../server/audio/demo.mjs'
import { decode } from '../server/audio/decode.mjs'
import { encode } from '../server/audio/encode.mjs'
import { inspect, repair } from '../server/repair/session.mjs'
import {
  inspectWorkbench, repairWorkbench, workbenchDemo
} from '../server/workbench/session.mjs'
import {
  createState, swapAppearances, splitAppearance, replaceAudio, isWorkbenchInput,
  cutClip, placeClip
} from '../server/workbench/index.mjs'

const sample = demo()
const rate = 16000
const f = sec => Math.round(sec * rate)
const lenA = f(0.62) - f(0.2)
const lenB = f(1.46) - f(0.86)
const totalABA = lenA + lenB + lenA

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
function replacementWav(frames, freq = 660) {
  const tracks = [0, 1].map(ch => Float64Array.from({ length: frames }, (_, i) =>
    0.3 * Math.sin(2 * Math.PI * freq * i / rate) * (ch ? 0.8 : 1)))
  return encode({ tracks, rate, frames }).toString('base64')
}
function intSamples(base64) {
  return decode(base64).tracks.map(t =>
    Int16Array.from(t, x => Math.max(-32768, Math.min(32767, Math.round(x * 32768)))))
}

test('classic whole-file entry stays byte-compatible', () => {
  const a = inspect(sample)
  assert.equal(a.frames, 48000)
  const empty = repair({ ...sample, regions: [] })
  assert.equal(empty.wav, sample.wav)
  assert.equal(empty.editedWindows, 0)
  // workbench payloads dispatch through the known session entry
  assert.equal(isWorkbenchInput(bench()), true)
  assert.equal(isWorkbenchInput(sample), false)
  const wi = inspect(bench())
  assert.equal(wi.frames, totalABA)
  assert.ok(repair(bench()).wav)
})

test('stitched frames, rate and channel order preserved', () => {
  const r = inspectWorkbench(bench())
  assert.equal(r.frames, totalABA)
  assert.equal(r.stitchedFrames, totalABA)
  assert.equal(r.rate, 16000)
  assert.equal(r.channels, 2)
  assert.equal(r.spectrum.duration, totalABA / rate)
})

test('originalWav follows current A-B-A order sample-exactly', () => {
  const out = intSamples(inspectWorkbench(bench()).originalWav)
  const src = intSamples(sample.wav)
  const ranges = [[f(0.2), f(0.62)], [f(0.86), f(1.46)], [f(0.2), f(0.62)]]
  let off = 0
  for (const [s, e] of ranges) {
    for (let i = 0; i < e - s; i++) for (let c = 0; c < 2; c++) {
      assert.equal(out[c][off + i], src[c][s + i])
    }
    off += e - s
  }
})

test('box is bound to the latter A and follows that appearance on swap', () => {
  const region = { id: 'box', takeId: 'a2', start: 0.06, end: 0.38, low: 200, high: 1000, db: 18 }
  const before = inspectWorkbench(bench({ regions: [region] }))
  assert.equal(before.boxes[0].startFrame, lenA + lenB + f(0.06))

  const swapped = swapAppearances(bench({ regions: [region] }), 0, 2)
  assert.deepEqual(swapped.items.map(i => i.takeId), ['a2', 'b1', 'a1'])
  const after = inspectWorkbench(swapped)
  const box = after.boxes.find(b => b.id === 'box')
  assert.equal(box.takeId, 'a2')
  assert.equal(box.startFrame, f(0.06))
  assert.equal(box.endFrame, f(0.38))
})

test('attenuation location moves with the bound appearance after swap', () => {
  const region = { takeId: 'a2', start: 0.05, end: 0.4, low: 120, high: 1200, db: 28 }
  const w1 = intSamples(repairWorkbench(bench({ regions: [region] })).wav)
  const w2 = intSamples(repairWorkbench(swapAppearances(bench({ regions: [region] }), 0, 2)).wav)
  const orig = intSamples(inspectWorkbench(bench()).originalWav)
  const energy = (w, s, e) => {
    let v = 0
    for (let i = s; i < e; i++) for (let c = 0; c < 2; c++) v += (w[c][i] - orig[c][i]) ** 2
    return v
  }
  assert.ok(energy(w1, lenA + lenB, totalABA) > energy(w1, 0, lenA) * 5)
  assert.ok(energy(w2, 0, lenA) > energy(w2, lenA + lenB, totalABA) * 5)
})

test('hard cut isolates sides: equal-length replacement leaves other side unchanged', () => {
  const xFrames = f(0.5), yFrames = f(0.55)
  const base = {
    wav: sample.wav,
    clips: [
      { id: 'X', startFrame: f(0.1), endFrame: f(0.1) + xFrames },
      { id: 'Y', startFrame: f(1.6), endFrame: f(1.6) + yFrames }
    ],
    items: [{ id: 'x', takeId: 'x', clip: 'X' }, { id: 'y', takeId: 'y', clip: 'Y' }],
    hardCuts: ['x'],
    regions: [{ id: 'ry', takeId: 'y', start: 0.05, end: 0.4, low: 300, high: 2600, db: 16 }]
  }
  const beforeI = inspectWorkbench(base)
  const beforeR = repairWorkbench(base)
  const changed = replaceAudio(base, 'x', replacementWav(xFrames, 720))
  const afterI = inspectWorkbench(changed)
  const afterR = repairWorkbench(changed)

  const sy0 = beforeI.spans.find(s => s.frameStart === xFrames)
  const sy1 = afterI.spans.find(s => s.frameStart === xFrames)
  assert.deepEqual(sy1.spectrum.values, sy0.spectrum.values)
  for (const t of [0.1, 0.25, 0.45]) for (const hz of [400, 1000, 1800]) {
    assert.deepEqual(afterI.readAt(xFrames / rate + t, hz), beforeI.readAt(xFrames / rate + t, hz))
  }
  const a = intSamples(beforeR.wav), b = intSamples(afterR.wav)
  for (let i = xFrames; i < xFrames + yFrames; i++) for (let c = 0; c < 2; c++) {
    assert.equal(b[c][i], a[c][i])
  }
})

test('positioning-only split within one appearance changes nothing', () => {
  const state = {
    wav: sample.wav,
    clips: [{ id: 'A', startFrame: f(0.2), endFrame: f(0.9) }],
    items: [{ id: 't1', takeId: 't1', clip: 'A' }],
    regions: [{ id: 'box', takeId: 't1', start: 0.08, end: 0.62, low: 220, high: 2400, db: 22 }]
  }
  const split = splitAppearance(state, 't1', f(0.5), { relative: 'local' })
  assert.equal(split.items.length, 2)
  assert.equal(new Set(split.items.map(i => i.takeId)).size, 1)
  const i1 = inspectWorkbench(state), i2 = inspectWorkbench(split)
  assert.deepEqual(i2.boxes, i1.boxes)
  assert.deepEqual(i2.spectrum.values, i1.spectrum.values)
  assert.deepEqual(i2.spectrum.centers, i1.spectrum.centers)
  assert.equal(repairWorkbench(split).wav, repairWorkbench(state).wav)
})

test('circled band attenuates; unselected span across hard cut is sample-exact', () => {
  const xFrames = f(0.7), yFrames = f(0.7)
  const state = {
    wav: sample.wav,
    clips: [
      { id: 'X', startFrame: f(0.7), endFrame: f(0.7) + xFrames },
      { id: 'Y', startFrame: f(2.2), endFrame: f(2.2) + yFrames }
    ],
    items: [{ id: 'x', takeId: 'x', clip: 'X' }, { id: 'y', takeId: 'y', clip: 'Y' }],
    hardCuts: ['x'],
    regions: [{ takeId: 'x', start: 0.05, end: 0.65, low: 1450, high: 1750, db: 30 }]
  }
  const before = inspectWorkbench(state)
  const after = repairWorkbench(state)
  assert.ok(after.readAt(0.35, 1600).db < before.readAt(0.35, 1600).db - 8)
  const repaired = intSamples(after.wav), original = intSamples(after.originalWav)
  for (let i = xFrames; i < xFrames + yFrames; i++) for (let c = 0; c < 2; c++) {
    assert.equal(repaired[c][i], original[c][i])
  }
})

test('repair audition/download share one PCM16 WAV with correct header', () => {
  const r = repairWorkbench(bench({ regions: [{ takeId: 'a2', start: 0.05, end: 0.3, low: 300, high: 2000, db: 18 }] }))
  assert.equal(r.wav, r.repairedWav)
  assert.equal(r.wav, r.downloadWav)
  assert.equal(r.wav, r.auditionWav)
  const buf = Buffer.from(r.wav, 'base64')
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF')
  assert.equal(buf.readUInt16LE(20), 1)
  assert.equal(buf.readUInt16LE(22), 2)
  assert.equal(buf.readUInt32LE(24), 16000)
  assert.equal(buf.readUInt16LE(34), 16)
  assert.equal(buf.readUInt32LE(40), totalABA * 4)
  assert.equal(decode(r.wav).frames, totalABA)
})

test('demo workbench and duration limit', () => {
  const d = workbenchDemo()
  assert.equal(inspectWorkbench(d).items.length, 3)
  assert.ok(repairWorkbench(d).wav)
  const long = { wav: sample.wav, items: Array.from({ length: 20 }, (_, i) => ({ id: `i${i}`, startFrame: 0, endFrame: f(0.4) })) }
  assert.throws(() => inspectWorkbench(long), /时长/)
})

test('state builders produce distinct reusable takes', () => {
  let s = createState({ wav: sample.wav })
  s = cutClip(s, { id: 'A', startFrame: 100, endFrame: 500 })
  s = placeClip(s, 'A', { id: 't1' })
  s = placeClip(s, 'A', { id: 't2' })
  assert.equal(s.items.length, 2)
  assert.equal(s.items[0].startFrame, 100)
  assert.notEqual(s.items[0].takeId, s.items[1].takeId)
})

