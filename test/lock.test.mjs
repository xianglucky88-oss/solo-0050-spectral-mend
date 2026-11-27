import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BLOCK_FRAMES, validateGeometry, detectImpact, relocate,
  lockInspect, lockMove, lockDemo, LOCK_DEMO
} from '../server/lock/index.mjs'
import { decodePcm16 } from '../server/audio/pcm16.mjs'

const demo = lockDemo()
const locks = demo.locks.map(l => ({ search: l.search, targetFrame: l.targetFrame }))

test('常量为 32 / 16 / 2', async () => {
  const g = await import('../server/lock/geometry.mjs')
  assert.equal(BLOCK_FRAMES, 32)
  assert.equal(g.EDGE_FRAMES, 16)
  assert.equal(g.JOIN_FRAMES, 2)
})

test('双路确认并给出零起算唯一源帧', () => {
  const pcm = decodePcm16(demo.wav).pcm
  for (let i = 0; i < 2; i++) {
    const r = detectImpact(pcm, demo.locks[i].search.start, demo.locks[i].search.end)
    assert.equal(r.unique, true)
    assert.equal(r.frame, demo.sourceFrames[i])
  }
  const amb = detectImpact(pcm, demo.presets.ambiguousSearch.start, demo.presets.ambiguousSearch.end)
  assert.equal(amb.unique, false)
})

test('inspect 生成前显示零起算源帧', () => {
  const r = lockInspect({ wav: demo.wav, segment: demo.segment, locks })
  assert.deepEqual(r.sourceFrames, demo.sourceFrames)
  assert.equal(r.zeroBased, true)
})

test('几何：重叠/越段/侵入 16/净距 2', () => {
  const seg = [demo.segment.start, demo.segment.end]
  assert.equal(validateGeometry({ segment: seg, items: demo.sourceFrames.map((s, i) =>
    ({ sourceFrame: s, targetFrame: demo.targetFrames[i] })) }).ok, true)
  assert.equal(validateGeometry({ segment: seg, items: [{ sourceFrame: 14000, targetFrame: 20000 },
    { sourceFrame: 33000, targetFrame: 20033 }] }).ok, false)
})

test('move：目标 32 帧双路与源逐码一致，保护段不变，WAV 等长 PCM16', () => {
  const r = lockMove({ wav: demo.wav, segment: demo.segment, locks })
  assert.equal(r.changed, true)
  const src = decodePcm16(demo.wav), out = decodePcm16(r.wav)
  assert.equal(out.rate, src.rate); assert.equal(out.frames, src.frames); assert.equal(out.channels, 2)
  const [a, b] = [demo.segment.start, demo.segment.end]
  for (const l of r.locks) {
    for (const c of [0, 1]) {
      for (let k = 0; k < 32; k++) assert.equal(out.pcm[c][l.targetFrame + k], src.pcm[c][l.sourceFrame + k])
      for (let i = 0; i < src.frames; i++) {
        if (i < a + 16 || i >= b - 16) assert.equal(out.pcm[c][i], src.pcm[c][i])
      }
    }
  }
})

test('非唯一撞击：原样回传 wav 并要求重圈', () => {
  const r = lockMove({ wav: demo.wav, segment: demo.segment,
    locks: [{ search: demo.presets.ambiguousSearch, targetFrame: 20000 }, locks[1]] })
  assert.equal(r.changed, false)
  assert.equal(r.needReselect, true)
  assert.equal(r.wav, demo.wav)
})

test('接声无解：原样回传 wav 并提示调整目标', () => {
  const r = lockMove({ wav: demo.wav, segment: demo.segment,
    locks: [{ search: demo.locks[0].search, targetFrame: demo.presets.fadeTarget }, locks[1]] })
  assert.equal(r.changed, false)
  assert.equal(r.code, 'no-join-solution')
  assert.equal(r.wav, demo.wav)
})

test('relocate 纯引擎在自动辨认声线下也成立', () => {
  const pcm = decodePcm16(demo.wav).pcm
  const r = relocate({ pcm, rate: 16000, segment: [demo.segment.start, demo.segment.end],
    items: demo.sourceFrames.map((s, i) => ({ sourceFrame: s, targetFrame: demo.targetFrames[i] })) })
  assert.equal(r.ok, true)
  assert.equal(r.envelope.feasible, true)
})
