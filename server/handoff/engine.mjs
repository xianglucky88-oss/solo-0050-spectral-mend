import { InputError } from '../http/error.mjs'
import { decode } from '../audio/decode.mjs'
import { windowPlan } from '../spectrum/window.mjs'
import { rebuild } from '../repair/rebuild.mjs'
import { regions as validateRegions } from '../repair/regions.mjs'
import { toCodes, clips, audioHash } from './pcm.mjs'
import { resolveSegment, resolveFrequencies, readAll } from './readings.mjs'
import { estimateTones, renderTones, stripTones, toneReadings } from './tones.mjs'
import { groupRegions, editedMask } from './groups.mjs'

const MAX_ITEMS = 8

function loadSource(input) {
  const audio = decode(input?.wav)
  const plan = windowPlan(audio.frames, input.size)
  const codes = toCodes(audio)
  return { audio, plan, codes }
}

// 每项可由多个选区组成；归一化为 engine 内部条目。
function normalizeItems(input, audio) {
  const raw = input.items
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > MAX_ITEMS) {
    throw new InputError(`交接需要 1–${MAX_ITEMS} 个核听项。`)
  }
  return raw.map((item, itemIndex) => {
    const list = validateRegions(item.regions, audio)
    const segment = resolveSegment(item.segment, audio.frames)
    const frequencies = resolveFrequencies(item.frequencies, audio.rate)
    const retained = item.retained ? resolveFrequencies(item.retained, audio.rate) : []
    for (const hz of retained) if (frequencies.includes(hz)) {
      throw new InputError('保留的带外频点不能与带内量测频点重合。')
    }
    return { id: item.id ?? `item-${itemIndex + 1}`, regions: list, segment, frequencies, retained,
      label: typeof item.label === 'string' ? item.label : undefined }
  })
}

function rebuildGroup(audio, plan, groupRegionsList) {
  const edited = rebuild(audio, plan, groupRegionsList)
  return { edited, codes: toCodes(edited) }
}

// 发送方：逐项修复并产出核听读数。可能改到同样点（含间接相连）的选区合为一项。
export function prepare(input) {
  const { audio, plan, codes } = loadSource(input)
  const items = normalizeItems(input, audio)
  const groups = groupRegions(plan, audio, items.map(item => ({ regions: item.regions })))
  const sourceHash = audioHash(codes, audio.rate)
  const prepared = groups.map(group => {
    const itemIds = group.members.map(index => items[index].id)
    const probe = items[group.members[0]]
    const { edited, codes: resultCodes } = rebuildGroup(audio, plan, group.regions)
    const mask = editedMask(codes, resultCodes)
    const before = readAll(codes, audio.rate, probe.segment, probe.frequencies)
    const after = readAll(resultCodes, audio.rate, probe.segment, probe.frequencies)
    const unique = before.every(channel => channel.unique) && after.every(channel => channel.unique)

    // 为每个声明的保留频点预算「扣除带外声线后的核准残差读数」，
    // 供接收方授权重做时在同一口径下比对。
    const toneApprovals = probe.retained.map(hz => {
      const sourceTone = estimateTones(codes, audio.rate, probe.segment, [hz])
      const resultTone = estimateTones(resultCodes, audio.rate, probe.segment, [hz])
      if (!sourceTone || !resultTone) return { retained: hz, resolvable: false }
      const residualCodes = stripTones(resultCodes, renderTones(resultTone, audio.rate, audio.frames))
      const residual = readAll(residualCodes, audio.rate, probe.segment, probe.frequencies)
      const tone = toneReadings(renderTones(resultTone, audio.rate, audio.frames),
        audio.rate, probe.segment, [hz])
      return {
        retained: hz,
        resolvable: residual.every(channel => channel.unique),
        residualReadings: residual.map(channel => channel.readings),
        toneReadings: tone,
      }
    })

    return {
      ids: itemIds,
      regions: group.regions,
      segment: probe.segment,
      frequencies: probe.frequencies,
      retained: probe.retained,
      frames: [...group.frames].sort((a, b) => a - b),
      editedMask: mask.map(set => [...set].sort((a, b) => a - b)),
      editedWindows: edited.editedWindows,
      clips: clips(edited),
      readings: { before: before.map(channel => channel.readings), after: after.map(channel => channel.readings) },
      readingsUnique: unique,
      toneApprovals,
    }
  })
  return {
    source: { rate: audio.rate, frames: audio.frames, channels: audio.tracks.length, hash: sourceHash, size: plan.size },
    items: prepared,
  }
}

