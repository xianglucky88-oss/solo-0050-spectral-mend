import { InputError } from '../http/error.mjs'
import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { columns } from '../spectrum/columns.mjs'
import { toCodes, tracksFromCodes, audioHash, codeHash } from './pcm.mjs'
import { readAll, withinTolerance } from './readings.mjs'
import { editedMask, maskFromArraysSafe } from './groups.mjs'

// 重开一个交接会话：核验接收稿与合入记录。
// - 携带记录：凭可核实合入记录与吻合的修后读数标记已合入。
// - 无记录 WAV（同一 PCM 另存）：仍按本地副本判冲突，不凭空标记合入。
// - 重复导入同一 PCM：判定结果保持不变。
export function reopen(input) {
  const bundle = input?.bundle
  const working = decode(input?.wav)
  if (!bundle || bundle.version !== 1 || !bundle.source?.wav) throw new InputError('需要交接记录才能核验合入状态。')
  const source = decode(bundle.source.wav)
  assertSameShape(working, source)
  const plan = windowPlan(working.frames, bundle.source.size)
  const rate = working.rate

  const sourceCodes = toCodes(source)
  const workingCodes = toCodes(working)
  const localMask = editedMask(sourceCodes, workingCodes)

  const verified = []
  const verifiedMasks = []
  for (const record of bundle.merges ?? []) {
    const item = bundle.items.find(candidate => candidate.id === record.id)
    if (!item) { verified.push({ id: record.id, state: 'orphan-record' }); continue }
    const mask = maskFromArraysSafe(record.editedMask)
    // 本地归属：把该项写位外的样点还原成原件，只保留该项自身的编辑，
    // 从而在重开时排除其他项合入对核听读数的影响（即使核听段跨项）。
    const isolated = workingCodes.map((channel, c) =>
      Int16Array.from(channel, (value, frame) => mask[c].has(frame) ? value : sourceCodes[c][frame]))
    const observed = readAll(isolated, rate, item.segment, item.frequencies)
    const readingsOk = observed.every(channel => channel.unique) &&
      observed.every((channel, c) => withinTolerance(item.readings.after[c], channel.readings))
    const touched = mask.filter((set, channel) =>
      [...set].some(frame => workingCodes[channel][frame] !== sourceCodes[channel][frame])).length
    const state = readingsOk && touched > 0 ? 'merged' : 'record-mismatch'
    if (state === 'merged') verifiedMasks.push(mask)
    verified.push({ id: record.id, state, kind: record.kind })
  }

  const verifiedMask = verifiedMasks.length ? unionSets(verifiedMasks) : localMask.map(() => new Set())
  const conflicts = (bundle.items ?? [])
    .filter(item => !(bundle.merges ?? []).some(record => record.id === item.id))
    .map(item => {
      const writeMask = maskFromArraysSafe(item.editedMask)
      const foreign = subtractSets(localMask, verifiedMask)
      return { id: item.id, conflict: overlaps(writeMask, foreign) }
    })
    .filter(entry => entry.conflict)

  return {
    wav: encode(working).toString('base64'),
    spectrum: columns(tracksFromCodes(workingCodes, rate, working.frames), plan),
    workingHash: audioHash(workingCodes, rate),
    sourceHash: audioHash(sourceCodes, rate),
    records: verified,
    conflicts: conflicts.map(entry => entry.id),
  }
}

// 无记录 WAV：仅按 PCM 内容识别为本地副本，标出与各项写位的冲突，不产生合入标记。
export function inspectCopy(input) {
  const working = decode(input?.wav)
  if (!input?.items || !Array.isArray(input.items)) throw new InputError('需要候选核听项以判定本地副本冲突。')
  const source = decode(input.sourceWav)
  assertSameShape(working, source)
  const sourceCodes = toCodes(source), workingCodes = toCodes(working)
  const localMask = editedMask(sourceCodes, workingCodes)
  const conflicts = input.items
    .map(item => ({ id: item.id, conflict: overlaps(maskFromArraysSafe(item.editedMask), localMask) }))
    .filter(entry => entry.conflict)
    .map(entry => entry.id)
  return { workingHash: audioHash(workingCodes, working.rate), codeHash: codeHash(workingCodes), conflicts }
}

function assertSameShape(a, b) {
  if (a.rate !== b.rate || a.frames !== b.frames || a.tracks.length !== b.tracks.length) {
    throw new InputError('接收稿与原件的采样率、声道顺序或帧数不一致。')
  }
}

function unionSets(masks) {
  const channels = masks[0].map(() => new Set())
  for (const mask of masks) mask.forEach((set, channel) => { for (const v of set) channels[channel].add(v) })
  return channels
}

function subtractSets(mask, removed) {
  return mask.map((set, channel) => {
    const result = new Set()
    for (const v of set) if (!removed[channel].has(v)) result.add(v)
    return result
  })
}

function overlaps(a, b) {
  return a.some((set, channel) => {
    const [small, large] = set.size <= b[channel].size ? [set, b[channel]] : [b[channel], set]
    for (const v of small) if (large.has(v)) return true
    return false
  })
}
