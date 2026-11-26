import { InputError } from '../http/error.mjs'
import { decode } from '../audio/decode.mjs'
import { encode } from '../audio/encode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { rebuild } from '../repair/rebuild.mjs'
import { columns } from '../spectrum/columns.mjs'
import { toCodes, tracksFromCodes, introducesClipping, codeHash, audioHash } from './pcm.mjs'
import { readAll, withinTolerance, resolveFrequencies } from './readings.mjs'
import { estimateTones, renderTones, stripTones, addTones, toneReadings } from './tones.mjs'
import { editedMask, maskOverlaps, unionMasks } from './groups.mjs'

function maskFromArrays(arrays) {
  return arrays.map(list => new Set(list))
}

function arraysFromMask(mask) {
  return mask.map(set => [...set].sort((a, b) => a - b))
}

// 接收方提交合入。workingWav 为接收稿（可能已含其他项合入或本地编辑），
// bundle 为可核实的交接记录，authorizations 给出按项授权与保留频点。
export function commit(input) {
  const bundle = requireBundle(input?.bundle)
  const working = decode(input?.wav)
  const source = decode(bundle.source.wav)
  assertSameShape(working, source)
  const plan = windowPlan(working.frames, bundle.source.size)
  const authorizations = normalizeAuthorizations(input.authorizations, bundle)

  const sourceCodes = toCodes(source)
  const workingCodes = toCodes(working)
  const frames = working.frames, rate = working.rate

  // 接收稿相对原件的全部本地编辑（含历史合入与接收方自己的改动）。
  const localMask = editedMask(sourceCodes, workingCodes)

  // 已合入项占用的写位（凭可核实记录），用于把历史合入从冲突判定中排除。
  const mergedMask = unionMasks(bundle.merges.map(entry => maskFromArrays(entry.editedMask)),
    sourceCodes.length)
  const mergedIds = new Set(bundle.merges.map(entry => entry.id))
  // 写位上不属于历史合入的本地编辑，才构成默认冲突。
  const foreignMask = subtractMask(localMask, mergedMask)

  const nextCodes = workingCodes.map(channel => Int16Array.from(channel))
  const newMerges = []
  const results = []

  for (const item of bundle.items) {
    if (mergedIds.has(item.id)) { results.push(status(item.id, 'already-merged')); continue }
    const auth = authorizations.get(item.id)
    const writeMask = maskFromArrays(item.editedMask)

    if (maskOverlaps(writeMask, foreignMask)) {
      results.push(status(item.id, 'conflict', { reason: '写位存在未授权本地编辑。' }))
      continue
    }

    if (auth?.redo) {
      const outcome = applyRedo({ item, auth, sourceCodes, workingCodes, nextCodes, plan, rate, frames })
      results.push(outcome.result)
      if (outcome.merged) newMerges.push(outcome.merge)
    } else {
      const outcome = applyStandard({ item, sourceCodes, nextCodes, plan, rate, frames })
      results.push(outcome.result)
      if (outcome.merged) newMerges.push(outcome.merge)
    }
  }

  const merged = tracksFromCodes(nextCodes, rate, frames)
  const nextBundle = {
    ...bundle,
    workingHash: audioHash(nextCodes, rate),
    merges: [...bundle.merges, ...newMerges],
  }
  return {
    wav: encode(merged).toString('base64'),
    spectrum: columns(merged, plan),
    metrics: commitMetrics(workingCodes, nextCodes),
    bundle: nextBundle,
    results,
  }
}

function applyStandard({ item, sourceCodes, nextCodes, plan, rate, frames }) {
  // 在未编辑原件上重建该项，确保读数只反映该项本地编辑。
  const source = tracksFromCodes(sourceCodes, rate, frames)
  const rebuilt = rebuild(source, plan, item.regions)
  if (introducesClipping(source, rebuilt)) return reject(item.id, 'rebuild-clips', '该修复量化后会削波。')
  const rebuiltCodes = toCodes(rebuilt)

  // 未授权改动核验：发送记录的修后读数必须与原件重建结果吻合（容差 2 码）。
  const expected = readAll(rebuiltCodes, rate, item.segment, item.frequencies)
  if (!expected.every(channel => channel.unique)) return reject(item.id, 'non-unique', '修后读数不唯一。')
  const recorded = item.readings.after.map(channel => channel)
  const matches = expected.every((channel, c) => withinTolerance(recorded[c], channel.readings))
  if (!matches) return reject(item.id, 'readings-mismatch', '发送方修后读数与原件重建不符，存在未授权改动。')

  writeItem(nextCodes, rebuiltCodes, item.editedMask)
  return {
    merged: true,
    merge: mergeRecord(item, rebuiltCodes, 'standard'),
    result: status(item.id, 'merged', { readings: expected.map(channel => channel.readings) }),
  }
}

function applyRedo({ item, auth, sourceCodes, workingCodes, nextCodes, plan, rate, frames }) {
  const retained = auth.retained
  // 发送方必须已为这组保留频点预算可分辨的核准残差读数。
  const approval = (item.toneApprovals ?? []).find(entry =>
    entry.resolvable && sameList(entry.retained === undefined ? [] : [entry.retained], retained))
  if (!approval) return reject(item.id, 'tone-unresolved', '交接记录缺少该保留频点的可分辨声线核准。')

  // 带外声线在接收稿的核听段上估计；无法分辨（秩亏）则保留接收稿。
  const coefficients = estimateTones(workingCodes, rate, item.segment, retained)
  if (!coefficients) return reject(item.id, 'tone-unresolved', '带外声线无法分辨。')
  const toneTracks = renderTones(coefficients, rate, frames)
  const baseCodes = stripTones(workingCodes, toneTracks)
  const base = tracksFromCodes(baseCodes, rate, frames)

  // 重做仅作用于授权选区；其余带外内容以声线形式保留。
  const redoRegions = auth.regions ?? item.regions
  const rebuilt = rebuild(base, plan, redoRegions)
  if (introducesClipping(base, rebuilt)) return reject(item.id, 'rebuild-clips', '重做量化后会削波。')
  const residualCodes = toCodes(rebuilt)
  const finishedCodes = addTones(residualCodes, toneTracks)
  // 声线加回若触发 PCM16 饱和钳制，成品会削波，保留接收稿。
  if (saturatesOnAdd(residualCodes, toneTracks)) {
    return reject(item.id, 'rebuild-clips', '声线加回后成品会削波。')
  }

  // 残差核准读数：扣除声线后的信号，与发送方同频点核准残差读数容差内一致。
  const residualReadings = readAll(residualCodes, rate, item.segment, item.frequencies)
  if (!residualReadings.every(channel => channel.unique)) return reject(item.id, 'non-unique', '残差读数不唯一。')
  const residualOk = residualReadings.every((channel, c) =>
    withinTolerance(approval.residualReadings[c], channel.readings))
  if (!residualOk) return reject(item.id, 'readings-mismatch', '重做残差读数与核准读数不符。')

  // 带外声线须原样保留：写位只取残差（带内）真正改动的样点，
  // 声线所在码值不重写，故成品声线读数与接收稿天然一致（差 0 码）。
  const residualMask = editedMask(baseCodes, residualCodes)
  const receiverToneReadings = toneReadings(toneTracks, rate, item.segment, retained)
  const finishedToneReadings = receiverToneReadings
  writeItem(nextCodes, finishedCodes, arraysFromMask(residualMask))
  return {
    merged: true,
    merge: mergeRecord(item, finishedCodes, 'redo', { retained, editedMask: arraysFromMask(residualMask) }),
    result: status(item.id, 'merged-redo', {
      readings: residualReadings.map(channel => channel.readings),
      toneReadings: finishedToneReadings,
    }),
  }
}

function sameList(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

// 残差码值与声线相加后是否越过 PCM16 范围（即 addTones 会执行饱和钳制）。
function saturatesOnAdd(residualCodes, toneTracks) {
  return residualCodes.some((channel, c) => {
    for (let i = 0; i < channel.length; i++) {
      const sum = channel[i] + toneTracks[c][i]
      if (sum < -32768 || sum > 32767) return true
    }
    return false
  })
}

function writeItem(target, source, maskArrays) {
  maskArrays.forEach((frames_, channel) => {
    for (const frame of frames_) target[channel][frame] = source[channel][frame]
  })
}

function mergeRecord(item, codes, kind, extra = {}) {
  return {
    id: item.id,
    kind,
    resultHash: codeHash(codes),
    editedMask: extra.editedMask ?? item.editedMask,
    segment: item.segment,
    frequencies: item.frequencies,
    readings: item.readings,
    ...extra,
  }
}

function subtractMask(mask, removed) {
  return mask.map((set, channel) => {
    const result = new Set()
    for (const frame of set) if (!removed[channel].has(frame)) result.add(frame)
    return result
  })
}

function reject(id, code, reason) {
  return { merged: false, merge: null, result: status(id, 'retained', { code, reason }) }
}

function status(id, state, extra = {}) {
  return { id, state, ...extra }
}

function commitMetrics(before, after) {
  return before.map((channel, c) => {
    let delta = 0, saturation = 0
    for (let i = 0; i < channel.length; i++) {
      delta += (channel[i] - after[c][i]) ** 2
      if (after[c][i] === -32768 || after[c][i] === 32767) saturation++
    }
    return { differenceRms: Math.sqrt(delta / channel.length) / 32768, saturation }
  })
}

function requireBundle(bundle) {
  if (!bundle || bundle.version !== 1 || !bundle.source?.wav || !Array.isArray(bundle.items) ||
      !Array.isArray(bundle.merges)) throw new InputError('需要有效的交接记录。')
  return bundle
}

function assertSameShape(a, b) {
  if (a.rate !== b.rate || a.frames !== b.frames || a.tracks.length !== b.tracks.length) {
    throw new InputError('接收稿与原件的采样率、声道顺序或帧数不一致。')
  }
}

function normalizeAuthorizations(raw, bundle) {
  const map = new Map()
  if (raw === undefined) return map
  if (!Array.isArray(raw)) throw new InputError('授权需要按项给出。')
  const ids = new Set(bundle.items.map(item => item.id))
  for (const entry of raw) {
    if (!entry || !ids.has(entry.id)) throw new InputError('授权指向了未知核听项。')
    const retained = entry.retained ? resolveFrequencies(entry.retained, bundle.source.rate) : []
    if (entry.redo === true && retained.length === 0) throw new InputError('重做授权需要指定保留的带外频点。')
    map.set(entry.id, { redo: entry.redo === true, retained, regions: entry.regions })
  }
  return map
}
