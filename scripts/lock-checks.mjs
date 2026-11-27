// 落锁对轨的有界自检：逐条核对提示词中的硬规则。
// 运行：node scripts/lock-checks.mjs   （失败以非零码退出）
import assert from 'node:assert/strict'
import {
  BLOCK_FRAMES, EDGE_FRAMES, JOIN_FRAMES, validateGeometry,
  detectImpact, relocate, lockInspect, lockMove, lockDemo,
  buildLockDemoPcm, LOCK_DEMO, decodePcm16
} from '../server/lock/index.mjs'

let count = 0
const check = (name, fn) => { fn(); count++; console.log(`  ✓ ${name}`) }

const pcm = buildLockDemoPcm()
const rate = LOCK_DEMO.rate
const segment = LOCK_DEMO.segment
const seg = [segment.start, segment.end]
const validItems = LOCK_DEMO.sources.map((s, i) => ({ index: i, sourceFrame: s, targetFrame: LOCK_DEMO.targets[i] }))

console.log('常量契约')
check('32 帧保护片 / 段首尾 16 帧 / 至少 2 帧接声', () => {
  assert.equal(BLOCK_FRAMES, 32)
  assert.equal(EDGE_FRAMES, 16)
  assert.equal(JOIN_FRAMES, 2)
})

console.log('双路同时确认 + 唯一性 + 零起算源帧')
for (let i = 0; i < 2; i++) {
  check(`落锁 ${i + 1} 精确辨认到植入帧 ${LOCK_DEMO.sources[i]}（两路强弱可不同）`, () => {
    const r = detectImpact(pcm, LOCK_DEMO.searches[i].start, LOCK_DEMO.searches[i].end)
    assert.equal(r.unique, true)
    assert.equal(r.frame, LOCK_DEMO.sources[i])
    assert.equal(r.zeroBasedFrame, LOCK_DEMO.sources[i])
    assert.ok(r.leftStrength > 0 && r.rightStrength > 0)
    assert.ok(Math.abs(r.leftStrength - r.rightStrength) > 0.02, '两声部强弱应不同')
  })
}
check('一次圈入两次撞击 -> not-unique，提示重圈', () => {
  const r = detectImpact(pcm, LOCK_DEMO.ambiguousSearch.start, LOCK_DEMO.ambiguousSearch.end)
  assert.equal(r.unique, false)
  assert.equal(r.code, 'not-unique')
  assert.match(r.reason, /重圈/)
})
check('纯电机范围 -> 找不到唯一撞击', () => {
  const r = detectImpact(pcm, LOCK_DEMO.presets?.motorOnlySearch?.start ?? 22000, 24000)
  assert.equal(r.unique, false)
})

console.log('几何规则')
check('合法布局通过', () => assert.equal(validateGeometry({ segment: seg, items: validItems }).ok, true))
const geoCode = patch => validateGeometry({ segment: seg, items: patch }).violations.map(v => v.code)
check('源保护片重叠 -> source-overlap', () => {
  assert.ok(geoCode([{ sourceFrame: 14000, targetFrame: 20000 }, { sourceFrame: 14020, targetFrame: 42000 }]).includes('source-overlap'))
})
check('目标片重叠 -> target-overlap', () => {
  assert.ok(geoCode([{ sourceFrame: 14000, targetFrame: 20000 }, { sourceFrame: 33000, targetFrame: 20010 }]).includes('target-overlap'))
})
check('越段 -> *-out-of-segment', () => {
  assert.ok(geoCode([{ sourceFrame: 10, targetFrame: 20000 }]).some(c => c.endsWith('out-of-segment')))
})
check('侵入段首 16 帧 -> *-edge-intrusion', () => {
  assert.ok(geoCode([{ sourceFrame: segment.start + 4, targetFrame: 20000 }]).includes('source-edge-intrusion'))
})
check('目标片净距 1 帧 -> target-join；恰好 2 帧通过', () => {
  assert.ok(geoCode([{ sourceFrame: 14000, targetFrame: 20000 }, { sourceFrame: 33000, targetFrame: 20033 }]).includes('target-join'))
  assert.equal(validateGeometry({ segment: seg,
    items: [{ sourceFrame: 14000, targetFrame: 20000 }, { sourceFrame: 33000, targetFrame: 20034 }] }).ok, true)
})
check('目标与段首保留区净距 <2 -> target-head-join', () => {
  assert.ok(geoCode([{ sourceFrame: 14000, targetFrame: segment.start + 17 }]).includes('target-head-join'))
})

console.log('搬迁硬不变量')
const moved = relocate({ pcm, rate, segment: seg, items: validItems, frequencies: LOCK_DEMO.motor.frequencies })
check('合法请求 changed/moved 且不变量自检通过', () => {
  assert.equal(moved.ok, true); assert.equal(moved.changed, true)
  assert.equal(moved.invariant.ok, true)
})
check('每个目标帧起 32 帧双路整数原码与源逐码一致', () => {
  for (const it of validItems) for (let c = 0; c < 2; c++) for (let k = 0; k < 32; k++) {
    assert.equal(moved.pcm[c][it.targetFrame + k], pcm[c][it.sourceFrame + k])
  }
})
check('段首尾各 16 帧与圈外逐样不变', () => {
  for (let c = 0; c < 2; c++) for (let i = 0; i < pcm[c].length; i++) {
    if (i < seg[0] + EDGE_FRAMES || i >= seg[1] - EDGE_FRAMES) assert.equal(moved.pcm[c][i], pcm[c][i])
  }
})
check('渲染后各声线包络越限比 <= 5%', () => {
  assert.equal(moved.envelope.feasible, true)
  assert.ok(moved.envelope.worstRatio <= 0.05 + 1e-6)
})
check('目标左缘撞击步进与原声逐码一致（起声/相位不被平滑）', () => {
  for (const it of validItems) for (let c = 0; c < 2; c++) {
    const outStep = moved.pcm[c][it.targetFrame] - moved.pcm[c][it.targetFrame - 1]
    const srcStep = pcm[c][it.sourceFrame] - pcm[c][it.sourceFrame - 1]
    assert.equal(outStep, srcStep)
  }
})
check('源空洞重建边界步进不超过本地电机中位步进的 6 倍（无爆音、连续）', () => {
  for (let c = 0; c < 2; c++) {
    const steps = []
    for (let i = 24000; i < 26000; i++) steps.push(Math.abs(pcm[c][i] - pcm[c][i - 1]))
    const median = steps.sort((a, b) => a - b)[steps.length >> 1] || 1
    for (const it of validItems) {
      assert.ok(Math.abs(moved.pcm[c][it.sourceFrame] - moved.pcm[c][it.sourceFrame - 1]) <= 6 * median)
      assert.ok(Math.abs(moved.pcm[c][it.sourceFrame + 31] - moved.pcm[c][it.sourceFrame + 32]) <= 6 * median)
    }
  }
})

console.log('失败保留原声')
check('段尾渐弱目标 -> no-join-solution', () => {
  const r = relocate({ pcm, rate, segment: seg,
    items: [{ sourceFrame: 14000, targetFrame: LOCK_DEMO.fadeTarget }], frequencies: LOCK_DEMO.motor.frequencies })
  assert.equal(r.ok, false); assert.equal(r.code, 'no-join-solution')
})

console.log('工作台/WAV 契约（试听与下载共用的 PCM16）')
const demo = lockDemo()
check('内置样本为原采样率等长双声道', () => {
  assert.equal(demo.channels, 2); assert.equal(demo.rate, 16000); assert.equal(demo.frames, 64000)
})
const reqLocks = demo.locks.map(l => ({ search: l.search, targetFrame: l.targetFrame }))
const insp = lockInspect({ wav: demo.wav, segment: demo.segment, locks: reqLocks })
check('lockInspect 生成前给出零起算源帧', () => {
  assert.deepEqual(insp.sourceFrames, LOCK_DEMO.sources)
  assert.equal(insp.zeroBased, true)
})
const out = lockMove({ wav: demo.wav, segment: demo.segment, locks: reqLocks })
check('lockMove 返回 changed 与 base64 WAV', () => assert.equal(out.changed, true))
const decodedOut = decodePcm16(out.wav)
const decodedSrc = decodePcm16(demo.wav)
check('成品 WAV：同采样率/等长/双声道/PCM16，目标块逐码等于原声', () => {
  assert.equal(decodedOut.rate, decodedSrc.rate)
  assert.equal(decodedOut.frames, decodedSrc.frames)
  assert.equal(decodedOut.channels, 2)
  for (const l of out.locks) for (let c = 0; c < 2; c++) for (let k = 0; k < 32; k++) {
    assert.equal(decodedOut.pcm[c][l.targetFrame + k], decodedSrc.pcm[c][l.sourceFrame + k])
  }
})
check('找不到唯一撞击时 lockMove 原样回传同一 wav 并要求重圈', () => {
  const r = lockMove({ wav: demo.wav, segment: demo.segment,
    locks: [{ search: demo.presets.ambiguousSearch, targetFrame: 20000 }, reqLocks[1]] })
  assert.equal(r.changed, false); assert.equal(r.needReselect, true); assert.equal(r.wav, demo.wav)
})
check('接声无解时 lockMove 原样回传同一 wav 并提示调整目标', () => {
  const r = lockMove({ wav: demo.wav, segment: demo.segment,
    locks: [{ search: demo.locks[0].search, targetFrame: demo.presets.fadeTarget }, reqLocks[1]] })
  assert.equal(r.changed, false); assert.equal(r.code, 'no-join-solution')
  assert.equal(r.adjustTarget, true); assert.equal(r.wav, demo.wav)
})

console.log(`\nLOCK CHECKS PASSED：${count} 组断言全部通过。`)
