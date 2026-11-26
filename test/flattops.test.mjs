import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  findFlatTops, scanRange, renderFlatTops, halveSample, resolveRange,
  repairIdentity, interpolateSpan, toPcm16
} from '../server/repair/flattops.mjs'
import { encodePcm16Wav, decodePcm16 } from '../server/audio/pcm16.mjs'

function wavBase64(pcm, rate = 16000) {
  return encodePcm16Wav({ pcm: Array.isArray(pcm[0]) ? pcm : [pcm], rate }).toString('base64')
}

test('单个满幅样点不算平顶，但记为满幅瞬态', () => {
  const report = findFlatTops([0, 120, 32767, 120, 0])
  assert.equal(report.flatTops.length, 0)
  assert.equal(report.transients.length, 1)
  assert.equal(report.transients[0].start, 2)
})

test('两个等幅满幅样点构成平顶', () => {
  const report = findFlatTops([0, 32767, 32767, 0])
  assert.equal(report.flatTops.length, 1)
  assert.equal(report.flatTops[0].length, 2)
  assert.equal(report.flatTops[0].repairable, true)
})

test('圈线落在平顶中段也返回整段，且同一平顶只有一个对象', () => {
  const samples = [0, 100, 30000, 30000, 30000, 30000, 100, 0]
  // run [2..5]
  const middle = scanRange(samples, { startSample: 3, endSample: 4 })
  assert.equal(middle.flatTops.length, 1)
  assert.deepEqual([middle.flatTops[0].start, middle.flatTops[0].end], [2, 5])
  // 只圈住其中一个样点同样认整段
  const one = scanRange(samples, { startSample: 4, endSample: 4 })
  assert.deepEqual([one.flatTops[0].start, one.flatTops[0].end], [2, 5])
})

test('多条子区间选择映射到同一平顶，不能拆修', () => {
  const pcm = [[0, 100, 30000, 30000, 30000, 30000, 100, 0]]
  const ids = repairIdentity([
    { channel: 0, startSample: 2, endSample: 2 },
    { channel: 0, startSample: 4, endSample: 5 }
  ], pcm)
  assert.deepEqual(ids, ['flat-0-2-5'])
  const a = renderFlatTops(pcm, [{ channel: 0, startSample: 2, endSample: 2 }])
  const b = renderFlatTops(pcm, ['flat-0-2-5'])
  assert.deepEqual(a.pcm, b.pcm)
})

test('缺一侧有效波形的边界平顶标记证据不足且不得补峰', () => {
  const startBoundary = findFlatTops([30000, 30000, 20000, 18000])
  assert.equal(startBoundary.flatTops.length, 1)
  assert.equal(startBoundary.repairable.length, 0)
  assert.equal(startBoundary.evidence.length, 1)
  assert.equal(startBoundary.evidence[0].boundary, true)

  const endBoundary = findFlatTops([18000, 20000, 30000, 30000])
  assert.equal(endBoundary.evidence.length, 1)

  const out = renderFlatTops([[30000, 30000, 20000, 18000]], ['flat-0-0-1'])
  assert.equal(out.selected.length, 0)
  assert.equal(out.skipped.length, 1)
  assert.deepEqual(out.pcm[0], [15000, 15000, 10000, 9000])
})

test('未选样点严格等于工作台规则的减半舍入', () => {
  const original = [32767, -32768, 3, -3, 2, -2, 101, -101, 24576, -24576]
  const out = renderFlatTops([original], [])
  for (let i = 0; i < original.length; i++) {
    assert.equal(out.pcm[0][i], halveSample(original[i]))
    assert.equal(out.pcm[0][i], Math.round(original[i] / 2))
  }
})

test('只补选中对象：其余样点（含另一声道）逐点仅减半', () => {
  const ch0 = [100, 9000, 24000, 24000, 24000, 9000, 100]
  const ch1 = [50, 8000, 32767, 8000, 50, 60, 70]
  const out = renderFlatTops([ch0, ch1], ['flat-0-2-4'])
  for (const i of [0, 1, 5, 6]) assert.equal(out.pcm[0][i], Math.round(ch0[i] / 2))
  for (let i = 0; i < ch1.length; i++) assert.equal(out.pcm[1][i], Math.round(ch1[i] / 2))
})

test('补峰峰值严格超出原削平幅度，并接回两侧锚点', () => {
  const level = 20000
  const samples = [100, 14000, level, level, level, level, 14000, 100]
  const out = renderFlatTops([samples], ['flat-0-2-5'])
  const result = out.results[0]
  assert.equal(result.exceedsClipAmplitude, true)
  assert.ok(result.peak > level, `peak ${result.peak} > ${level}`)
  // 拱线从减半后的两侧锚点隆起，外侧样点本身不被修改，接缝同向无反向跳变。
  assert.equal(out.pcm[0][1], Math.round(14000 / 2))
  assert.equal(out.pcm[0][6], Math.round(14000 / 2))
  assert.ok(out.pcm[0][2] >= out.pcm[0][1])
  assert.ok(out.pcm[0][5] >= out.pcm[0][6])
  assert.ok(out.pcm[0][3] > level || out.pcm[0][4] > level)
})

test('负向平顶向下补出更深的峰', () => {
  const samples = [100, -14000, -20000, -20000, -20000, -14000, 100]
  const out = renderFlatTops([samples], ['flat-0-2-4'])
  assert.ok(Math.min(...out.pcm[0].slice(2, 5)) < -20000)
})

test('成品编码为等长 PCM16 WAV，scan 可直接读取', () => {
  const pcm = [
    [100, 15000, 24576, 24576, 24576, 15000, 100, 0, 32767, 0, 100, 200, 300, 400, 500, 600],
    [0, 100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200, 1300, 1400, 1500]
  ]
  const wav = wavBase64(pcm)
  const scanned = sessionModule.scan({ wav })
  assert.equal(scanned.frames, 16)
  assert.equal(scanned.channelCount, 2)
})

test('resolveRange 默认按样点，显式 seconds 时按秒', () => {
  assert.deepEqual(resolveRange({ start: 3, end: 6 }, 16000, 100),
    { start: 3, end: 6, startSample: 3, endSample: 6 })
  assert.deepEqual(resolveRange({ start: 1, end: 1.5, timeUnit: 'seconds' }, 16000, 48000),
    { start: 16000, end: 24000, startSample: 16000, endSample: 24000 })
  assert.deepEqual(resolveRange({ startSample: 5, endSample: 8 }, 16000, 100),
    { start: 5, end: 8, startSample: 5, endSample: 8 })
  assert.deepEqual(scanRange([0, 30000, 30000, 0], 1, 2).flatTops.map(c => c.id),
    ['flat-0-1-2'])
})

test('归一化浮点数组也能识别平顶', () => {
  const report = findFlatTops([0, 0.6, 1, 1, 1, 0.6, 0], { normalized: true })
  assert.equal(report.flatTops.length, 1)
  assert.deepEqual([report.flatTops[0].start, report.flatTops[0].end], [2, 4])
})

test('interpolateSpan 保持跨距外不变且接缝连续', () => {
  const samples = [0, 0.1, 0.2, 1, 1, 1, 0.3, 0.2, 0]
  const rebuilt = interpolateSpan(samples, [3, 5], 'linear')
  assert.deepEqual(rebuilt.slice(0, 3), samples.slice(0, 3))
  assert.deepEqual(rebuilt.slice(6), samples.slice(6))
  assert.ok(Math.abs(rebuilt[3] - rebuilt[2]) <= 0.05)
  assert.ok(Math.abs(rebuilt[5] - rebuilt[6]) <= 0.05)
})

test('WAV 整数往返：减半值与工作台规则一致', () => {
  const pcm = [[32767, -32768, 3, -3, 24576, -24576, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]]
  const wav = wavBase64(pcm)
  const decoded = decodePcm16(wav)
  assert.equal(decoded.rate, 16000)
  assert.equal(decoded.frames, 16)
  for (let i = 0; i < 16; i++) assert.equal(decoded.pcm[0][i], pcm[0][i])
})

import * as sessionModule from '../server/repair/session.mjs'

test('session scan/declip 端到端与等长成品', async () => {
  const { demo } = await import('../server/audio/demo.mjs')
  const sample = demo()
  const scanned = sessionModule.scan({ wav: sample.wav })
  assert.equal(scanned.channelCount, 2)
  assert.ok(scanned.clips.length >= 6)
  assert.ok(scanned.evidence.length >= 2)
  assert.ok(scanned.transients.length >= 3)
  const product = sessionModule.declip({ wav: sample.wav, selections: sample.suggestedSelections })
  assert.equal(product.frames, 48000)
  assert.equal(product.metrics.length, 2)
  const a = decodePcm16(sample.wav), b = decodePcm16(product.wav)
  assert.equal(b.frames, a.frames)
  assert.equal(product.wav.length === sample.wav.length, true)
  const selectedRanges = product.results.map(r => [r.channel, r.startSample, r.endSample])
  for (let c = 0; c < 2; c++) {
    for (let i = 0; i < a.frames; i++) {
      const touched = selectedRanges.some(([ch, s, e]) => ch === c && i >= s && i <= e)
      if (!touched) assert.equal(b.pcm[c][i], halveSample(a.pcm[c][i]), `unselected ${c}:${i}`)
    }
  }
})
