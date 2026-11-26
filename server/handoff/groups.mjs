import { gains } from '../repair/gains.mjs'
import { InputError } from '../http/error.mjs'

// 计算单个选区（或一组选区）在重建时确实改动的帧集合。
// 选区经时间渐变命中某些分析窗，这些窗覆盖的样点才可能被写入；
// 窗内未命中任何频格时 gain 为 null，该窗保持旁路。
export function affectedFrames(plan, audio, groupRegions) {
  const frames = new Set()
  for (const start of plan.starts) {
    const mask = gains(plan, audio, start, groupRegions)
    if (!mask) continue
    const first = Math.max(0, -start), end = Math.min(plan.size, audio.frames - start)
    for (let i = first; i < end; i++) frames.add(start + i)
  }
  return frames
}

// 两个选区是否会改到同一样点：帧集合相交即直接相连；
// 通过并查集把间接相连（A-B、B-C）也并入同一项。
export function groupRegions(plan, audio, entries) {
  const masks = entries.map(entry => affectedFrames(plan, audio, entry.regions))
  const parent = entries.map((_, index) => index)
  const find = index => parent[index] === index ? index : parent[index] = find(parent[index])
  const union = (a, b) => { parent[find(a)] = find(b) }
  for (let a = 0; a < entries.length; a++) for (let b = a + 1; b < entries.length; b++) {
    if (intersects(masks[a], masks[b])) union(a, b)
  }
  const groups = new Map()
  entries.forEach((entry, index) => {
    const root = find(index)
    if (!groups.has(root)) groups.set(root, [])
    groups.get(root).push(index)
  })
  return [...groups.values()].map(memberIndexes => ({
    members: memberIndexes,
    regions: memberIndexes.flatMap(index => entries[index].regions),
    frames: unionFrames(memberIndexes.map(index => masks[index])),
  }))
}

function intersects(a, b) {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a]
  for (const value of small) if (large.has(value)) return true
  return false
}

function unionFrames(masks) {
  const result = new Set()
  for (const mask of masks) for (const value of mask) result.add(value)
  return result
}

// 重建后真正与原件不同的码值位置（量化域），即该项确实改动原件的样点。
export function editedMask(sourceCodes, resultCodes) {
  const masks = sourceCodes.map((channel, c) => {
    const set = new Set()
    for (let i = 0; i < channel.length; i++) if (channel[i] !== resultCodes[c][i]) set.add(i)
    return set
  })
  return masks
}

export function maskOverlaps(a, b) {
  return a.some((set, channel) => {
    const [small, large] = set.size <= b[channel].size ? [set, b[channel]] : [b[channel], set]
    for (const frame of small) if (large.has(frame)) return true
    return false
  })
}

export function maskFromArraysSafe(arrays) {
  if (!Array.isArray(arrays)) throw new InputError('合入记录缺少有效的写位掩码。')
  return arrays.map(list => new Set(Array.isArray(list) ? list : []))
}

export function unionMasks(masks, channels = masks[0]?.length ?? 0) {
  const result = Array.from({ length: channels }, () => new Set())
  for (const mask of masks) mask.forEach((set, channel) => {
    for (const frame of set) result[channel].add(frame)
  })
  return result
}
