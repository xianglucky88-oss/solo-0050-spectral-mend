// 交接工作流协议的端到端核验。运行：node verify/handoff.test.mjs
import { demo } from '../server/audio/demo.mjs'
import { decode } from '../server/audio/decode.mjs'
import { repair } from '../server/repair/session.mjs'
import { handoffPrepare, handoffCommit, handoffReopen, handoffCopy } from '../server/handoff/session.mjs'
import { toCodes, tracksFromCodes } from '../server/handoff/pcm.mjs'
import { encode } from '../server/audio/encode.mjs'
import { readAll, withinTolerance } from '../server/handoff/readings.mjs'

let passed = 0
const check = (name, condition, detail = '') => {
  if (!condition) { console.error(`✗ ${name} ${detail}`); process.exitCode = 1 }
  else { passed++; console.log(`✓ ${name}`) }
}

const sample = demo()
const audio = decode(sample.wav)
// 核听段覆盖 1600 Hz 嗡鸣主体；带内量测频点含 0 Hz（自动）与两个谐波。
const segment = { first: Math.round(0.8 * audio.rate), last: Math.round(1.9 * audio.rate) }
const item = {
  id: 'hum',
  regions: [sample.region],
  segment,
  frequencies: [400, 1600],
  retained: [293],
}

// 1) 准备交接：读数唯一，含修前/修后读数。
const prepared = handoffPrepare({ wav: sample.wav, size: 512, items: [item] })
check('准备产出交接记录', prepared.bundle.version === 1 && prepared.bundle.items.length === 1)
const bundleItem = prepared.bundle.items[0]
check('修前修后读数均唯一', bundleItem.readingsUnique === true)
check('逐声道读数齐全', bundleItem.readings.before.length === audio.tracks.length &&
  bundleItem.readings.after.every(channel => channel.length === 3))

// 2) 接收方在干净原件上合入：成功，且与普通整体修复逐样相同。
const clean = handoffCommit({ wav: sample.wav, bundle: prepared.bundle, authorizations: [] })
const normalRepair = repair({ wav: sample.wav, size: 512, regions: [sample.region] })
check('干净原件合入成功', clean.results[0].state === 'merged')
check('全合入与普通修复逐样相同', clean.wav === normalRepair.wav)

// 3) 合入结果在核听段上的读数与发送方修后读数容差内一致。
const mergedCodes = toCodes(decode(clean.wav))
const mergedReadings = readAll(mergedCodes, audio.rate, segment, [400, 1600])
check('合入后读数吻合（≤2 码）', mergedReadings.every((channel, c) =>
  withinTolerance(bundleItem.readings.after[c], channel.readings)))

// 4) 重复提交同一已合入记录：标记 already-merged，PCM 不变（幂等）。
const again = handoffCommit({ wav: clean.wav, bundle: clean.bundle, authorizations: [] })
check('重复合入幂等', again.results[0].state === 'already-merged' && again.wav === clean.wav)

// 5) 重开核验：凭合入记录与吻合读数标记已合入。
const reopened = handoffReopen({ wav: clean.wav, bundle: clean.bundle })
check('重开标记已合入', reopened.records[0].state === 'merged')

// 6) 无记录 WAV（同一 PCM 另存）：按本地副本判冲突，不产生合入标记。
const copy = handoffCopy({ wav: clean.wav, sourceWav: sample.wav,
  items: [{ id: 'hum', editedMask: bundleItem.editedMask }] })
check('无记录副本仍判冲突', copy.conflicts.includes('hum'))
check('同一 PCM 指纹稳定', copy.workingHash === reopened.workingHash)

// 7) 写位上有未授权本地编辑 → 冲突，保留接收稿。
const tampered = toCodes(decode(sample.wav))
const writeFrame = bundleItem.editedMask[0][0]
tampered[0][writeFrame] = tampered[0][writeFrame] + 5
const tamperedWav = encode(tracksFromCodes(tampered, audio.rate, audio.frames)).toString('base64')
const conflict = handoffCommit({ wav: tamperedWav, bundle: prepared.bundle, authorizations: [] })
check('写位冲突被拦截', conflict.results[0].state === 'conflict')
check('冲突时保留接收稿', conflict.wav === tamperedWav)

// 8) 选区分组：两个间接相连的选区归入同一项。
const touching = [
  { ...item, id: 'a', regions: [{ ...sample.region, end: 1.4 }] },
  { ...item, id: 'b', regions: [{ ...sample.region, start: 1.3, end: 2.0 }] },
]
const grouped = handoffPrepare({ wav: sample.wav, size: 512, items: touching })
check('间接相连选区合并为一项', grouped.bundle.items.length === 1 &&
  grouped.bundle.items[0].memberIds.length === 2)

// 9) 读数不唯一不得核准：极短核听段导致秩亏。
const degenerate = handoffPrepare({ wav: sample.wav, size: 512,
  items: [{ ...item, segment: { first: 100, last: 101 }, frequencies: [400, 1600, 800] }] })
check('秩亏时读数不唯一', degenerate.bundle.items[0].readingsUnique === false)

// 10) 授权重做并保留带外频点：残差与声线读数均通过后合入。
const redo = handoffCommit({
  wav: sample.wav, bundle: prepared.bundle,
  authorizations: [{ id: bundleItem.id, redo: true, retained: [293] }],
})
check('授权重做合入成功', redo.results[0].state === 'merged-redo')
const redoReopen = handoffReopen({ wav: redo.wav, bundle: redo.bundle })
check('重做项重开仍标记已合入', redoReopen.records[0].state === 'merged')

// 11) 声线无法分辨时保留接收稿：保留频点与量测设计矩阵秩亏。
const badRedo = handoffCommit({
  wav: sample.wav, bundle: prepared.bundle,
  authorizations: [{ id: bundleItem.id, redo: true, retained: [400] }],
})
check('声线/频点冲突被拒绝或保留', ['retained', 'conflict'].includes(badRedo.results[0].state))

// 12) 保持采样率、声道顺序与帧数。
const output = decode(redo.wav)
check('输出保持 PCM 形状', output.rate === audio.rate && output.frames === audio.frames &&
  output.tracks.length === audio.tracks.length)

console.log(`\n${passed} 项通过`)
