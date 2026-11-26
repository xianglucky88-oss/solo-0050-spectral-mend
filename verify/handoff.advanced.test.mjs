// 进阶协议核验：多项隔离、削波、未授权改动、容差边界、参数变更重核准。
import { demo } from '../server/audio/demo.mjs'
import { decode } from '../server/audio/decode.mjs'
import { repair } from '../server/repair/session.mjs'
import { handoffPrepare, handoffCommit, handoffReopen } from '../server/handoff/session.mjs'
import { toCodes, tracksFromCodes } from '../server/handoff/pcm.mjs'
import { encode } from '../server/audio/encode.mjs'

let passed = 0
const check = (name, condition, detail = '') => {
  if (!condition) { console.error(`✗ ${name} ${detail}`); process.exitCode = 1 }
  else { passed++; console.log(`✓ ${name}`) }
}

const sample = demo()
const audio = decode(sample.wav)
const rate = audio.rate
const segment = { first: Math.round(0.8 * rate), last: Math.round(1.9 * rate) }

// 两个时间上分离、写位不相交的项。
const itemA = { id: 'a', regions: [{ ...sample.region, start: 0.7, end: 1.2 }], segment, frequencies: [400, 1600] }
const itemB = { id: 'b', regions: [{ ...sample.region, start: 1.5, end: 2.0 }], segment, frequencies: [400, 1600] }
const prepared = handoffPrepare({ wav: sample.wav, size: 512, items: [itemA, itemB] })
check('两个不相交项各自成项', prepared.bundle.items.length === 2)
const [bundleA, bundleB] = prepared.bundle.items

// 1) 一次性合入两个不相交项：各自读数独立判定，均成功且写位互不污染。
const mergeAll = handoffCommit({ wav: sample.wav, bundle: prepared.bundle, authorizations: [] })
check('两项各自合入成功', mergeAll.results.filter(r => r.state === 'merged').length === 2)
check('合入记录分别归属', new Set(mergeAll.bundle.merges.map(m => m.id)).size === 2)

// 2) 两项全合入后，与把两个选区一次性普通修复的 PCM 逐样相同。
const normalBoth = repair({ wav: sample.wav, size: 512, regions: [itemA.regions[0], itemB.regions[0]] })
check('逐项全合入等价整体修复', mergeAll.wav === normalBoth.wav)

// 3) 重开：两项都凭记录与读数标记已合入。
const reopened = handoffReopen({ wav: mergeAll.wav, bundle: mergeAll.bundle })
check('重开两项均标记已合入', reopened.records.length === 2 &&
  reopened.records.every(r => r.state === 'merged'))

// 3b) 顺序合入：先只授权 A 的等价做法是让 B 写位冲突；这里验证幂等再提交不变。
const secondPass = handoffCommit({ wav: mergeAll.wav, bundle: mergeAll.bundle, authorizations: [] })
check('已合入项重复提交保持 PCM 不变', secondPass.wav === mergeAll.wav &&
  secondPass.results.every(r => r.state === 'already-merged'))

// 4) 未授权改动：篡改发送方记录里的修后读数，该项应被读数核验拦截并保留接收稿，其他项照常合入。
const tamperedBundle = JSON.parse(JSON.stringify(prepared.bundle))
tamperedBundle.items[0].readings.after[0][1].cosine += 50
const bad = handoffCommit({ wav: sample.wav, bundle: tamperedBundle, authorizations: [] })
check('读数不符的未授权改动被拦截', bad.results.some(r => r.state === 'retained' && r.code === 'readings-mismatch'))
check('该项保留接收稿写位', bad.results.find(r => r.code === 'readings-mismatch').state === 'retained')
check('其他项照常合入', bad.results.some(r => r.state === 'merged'))

// 5) 削波保留：重做加回声线越过 PCM16 边界时，该项保留接收稿，其他项不受影响。
const hot = toCodes(decode(sample.wav))
// 把核听段内码值推到接近正饱和，使任何声线加回都会溢出。
for (let i = segment.first; i <= segment.last; i++) hot[0][i] = 32760
const hotWav = encode(tracksFromCodes(hot, rate, audio.frames)).toString('base64')
let clipResult
try {
  const hotPrepared = handoffPrepare({ wav: hotWav, size: 512,
    items: [{ id: 'c', regions: [sample.region], segment, frequencies: [400, 1600], retained: [293] }] })
  clipResult = handoffCommit({ wav: hotWav, bundle: hotPrepared.bundle,
    authorizations: [{ id: hotPrepared.bundle.items[0].id, redo: true, retained: [293] }] })
} catch (error) { clipResult = { results: [], wav: hotWav } }
const clipEntry = clipResult.results?.find(r => r.id === 'c')
check('削波项保留接收稿', clipEntry?.state === 'retained' && clipResult.wav === hotWav)

// 6) 窗长变更须重核准：512 的记录不能直接用于 1024 窗的修复核验（写位/读数不同）。
const prepared1024 = handoffPrepare({ wav: sample.wav, size: 1024, items: [{ ...itemA, id: 'a' }] })
const mask512 = new Set(bundleA.editedMask[0])
const mask1024 = new Set(prepared1024.bundle.items[0].editedMask[0])
let same = mask512.size === mask1024.size && [...mask512].every(v => mask1024.has(v))
check('窗长变化导致写位不同，需重核准', same === false)

// 7) 核听段跨项：同一段被两个项使用，读数仍各自独立归属（合入结果各带独立读数）。
check('跨项核听段读数独立', mergeAll.results.filter(r => r.readings).length === 2)

console.log(`\n${passed} 项通过`)
