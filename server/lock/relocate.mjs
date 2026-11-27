// 落锁搬迁核心（纯整数 PCM，不碰 HTTP/WAV）：
//  1) 几何硬校验：32 帧保护片、段首尾 16 帧、目标片/保留区之间 2 帧接声；
//  2) 从原声逐码截取每块 32 帧双路原码，按源帧原顺序处理；
//  3) 用稳态电机声线填补源空洞并做接声；
//  4) 目标片逐码粘贴；段首尾 16 帧与圈外严格不写；
//  5) 渲染后复核 5% 包络规则，无解则返回 ok:false 且 pcm 为原声。
import { BLOCK_FRAMES, EDGE_FRAMES, validateGeometry } from './geometry.mjs'
import { reconstructInterval, clampInt16 } from './motor.mjs'
import { detectFrequencies, evaluateEnvelope } from './envelope.mjs'

const COLLAR = 8 // 每侧最多迁移的源语境帧数（实际仍受接声间隙约束）

const deepCopy = pcm => pcm.map(ch => Array.from(ch))

// 计算目标片之间、以及目标片与段内可编辑区边界之间的全部接声间隙。
function buildGaps(items, a, b) {
  const byIndex = new Map(items.map(it => [it.index, it]))
  const slices = items.map((it, index) => ({ index, start: it.targetFrame, end: it.targetFrame + BLOCK_FRAMES }))
    .sort((x, y) => x.start - y.start)
  const innerA = a + EDGE_FRAMES, innerB = b - EDGE_FRAMES
  const gaps = []
  let cursor = innerA, leftIndex = null
  for (const slice of slices) {
    if (slice.start > cursor) gaps.push({ g0: cursor, g1: slice.start, left: leftIndex, right: slice.index })
    cursor = slice.end
    leftIndex = slice.index
  }
  if (cursor < innerB) gaps.push({ g0: cursor, g1: innerB, left: leftIndex, right: null })
  return { gaps, byIndex, slices }
}

// 在一个接声间隙内做“源后语境 → 电机床 → 源前语境”的短领接淡变。
function joinGap(out, original, channel, gap, items) {
  const { g0, g1, left, right } = gap
  const length = g1 - g0
  const leftItem = left === null ? null : items[left]
  const rightItem = right === null ? null : items[right]

  // 极小的片间接声间隙：首帧取左片源后语境、末帧取右片源前语境，
  // 保证与两块 32 帧原码各自逐样连续，不做互相冲突的长领淡变。
  if (leftItem && rightItem && length <= 4) {
    const post = leftItem.sourceFrame + BLOCK_FRAMES
    const preLast = rightItem.sourceFrame - 1
    if (post < original[channel].length) out[channel][g0] = original[channel][post]
    if (preLast >= 0) out[channel][g1 - 1] = original[channel][preLast]
    for (let k = 1; k < length - 1; k++) {
      const a = original[channel][post] ?? out[channel][g0 + k]
      const b = original[channel][preLast] ?? out[channel][g0 + k]
      out[channel][g0 + k] = Math.round(a * (1 - k / (length - 1)) + b * (k / (length - 1)))
    }
    return
  }

  for (let k = 0; k < length; k++) {
    const frame = g0 + k
    let value = out[channel][frame] / 32768 // 当前电机床（可能已被源空洞重建）
    if (leftItem) {
      const srcIndex = leftItem.sourceFrame + BLOCK_FRAMES + k
      if (k < COLLAR && srcIndex < original[channel].length) {
        const w = 1 - smooth(k / Math.min(COLLAR, length))
        value = w * (original[channel][srcIndex] / 32768) + (1 - w) * value
      }
    }
    if (rightItem) {
      const distance = g1 - frame // 距右片起点的帧数（1..length）
      const srcIndex = rightItem.sourceFrame - distance
      const r = length - distance // 领内序号
      const collar = Math.min(COLLAR, length)
      if (r >= length - collar && srcIndex >= 0) {
        const into = r - (length - collar) // 0..collar-1
        const w = smooth((into + 1) / collar)
        value = w * (original[channel][srcIndex] / 32768) + (1 - w) * value
      }
    }
    out[channel][frame] = clampInt16(Math.round(value * 32768))
  }
}

function smooth(x) { return x * x * (3 - 2 * x) }

export function relocate(input) {
  const { pcm, rate = 16000, segment, items: rawItems, locks, frequencies = null,
    tolerance = 0.05, enforceEnvelope = true } = input
  const items = (rawItems ?? locks ?? []).map((it, index) => ({
    index,
    sourceFrame: it.sourceFrame ?? it.source ?? null,
    targetFrame: it.targetFrame ?? it.target ?? null
  }))
  const seg = Array.isArray(segment) ? segment : [segment?.start, segment?.end]

  const geometry = validateGeometry({ segment: seg, items })
  if (!geometry.ok) {
    return { ok: false, changed: false, code: 'geometry', reason: geometry.violations[0]?.message,
      violations: geometry.violations, pcm, plan: { geometry } }
  }

  const [a, b] = seg
  const channels = pcm.length
  const original = pcm
  const out = deepCopy(original)

  // 声线：优先用调用方给定频率（内置样本/自检），否则在段内干净区辨认一次。
  let freqs = frequencies
  if (!Array.isArray(freqs) || freqs.length === 0) {
    freqs = safeDetectFrequencies(original, a, b, rate, items)
  }

  // 1) 源空洞电机重建（先做；若与目标片相交，稍后被原码覆盖）。
  for (const item of items) {
    for (let c = 0; c < channels; c++) {
      const filled = reconstructInterval(original[c], item.sourceFrame, item.sourceFrame + BLOCK_FRAMES,
        { rate, frequencies: freqs })
      for (let k = 0; k < BLOCK_FRAMES; k++) out[c][item.sourceFrame + k] = filled[k]
    }
  }

  // 2) 接声间隙淡变（在贴目标原码之前整理间隙电机床）。
  const { gaps } = buildGaps(items, a, b)
  for (const gap of gaps) for (let c = 0; c < channels; c++) joinGap(out, original, c, gap, items)

  // 3) 逐码粘贴 32 帧双路原码（最后写入，保证保护片就是原声原码）。
  for (const item of items) {
    for (let c = 0; c < channels; c++) {
      for (let k = 0; k < BLOCK_FRAMES; k++) {
        out[c][item.targetFrame + k] = original[c][item.sourceFrame + k]
      }
    }
  }

  // 4) 硬不变量自检：目标块逐码一致；段首尾 16 帧 + 圈外逐样不变。
  const invariant = verifyInvariants(original, out, seg, items)
  if (!invariant.ok) {
    return { ok: false, changed: false, code: 'invariant', reason: '搬迁不变量校验失败，已保留原声。',
      pcm: original, plan: { geometry, gaps }, invariant }
  }

  // 5) 5% 包络复核（渲染后）。无解则整体放弃，返回原声。
  let envelope = null
  if (enforceEnvelope) {
    envelope = evaluateEnvelope({ reference: original, candidate: out, rate, segment: seg,
      items, frequencies: freqs, tolerance })
    if (!envelope.feasible) {
      const worst = envelope.checks.filter(c => !c.ok).sort((x, y) => y.ratio - x.ratio)[0]
      return { ok: false, changed: false, code: 'no-join-solution',
        reason: '目标处包络与原声语境相差超过该声线原段峰值的 5%，接声无解，请调整目标帧后重试。',
        pcm: original, plan: { geometry, gaps }, envelope, worst }
    }
  }

  return { ok: true, changed: true, code: 'moved', reason: null, pcm: out,
    sourceFrames: items.map(i => i.sourceFrame), targetFrames: items.map(i => i.targetFrame),
    plan: { geometry, gaps, frequencies: freqs }, envelope, invariant }
}

function safeDetectFrequencies(pcm, a, b, rate, items) {
  // 选段中央、避开源/目标片的最长干净窗做声线辨认。
  const blocked = []
  for (const it of items) {
    if (Number.isInteger(it.sourceFrame)) blocked.push([it.sourceFrame, it.sourceFrame + BLOCK_FRAMES])
    if (Number.isInteger(it.targetFrame)) blocked.push([it.targetFrame, it.targetFrame + BLOCK_FRAMES])
  }
  blocked.sort((x, y) => x[0] - y[0])
  const candidates = []
  let cursor = a + EDGE_FRAMES
  for (const [s, e] of blocked) {
    if (s - cursor >= 512) candidates.push([cursor, s])
    cursor = Math.max(cursor, e)
  }
  if (b - EDGE_FRAMES - cursor >= 512) candidates.push([cursor, b - EDGE_FRAMES])
  candidates.push([a + EDGE_FRAMES, b - EDGE_FRAMES])
  candidates.sort((x, y) => (y[1] - y[0]) - (x[1] - x[0]))
  const [from, to] = candidates[0]
  try {
    return detectFrequencies(pcm, from, to, rate)
  } catch {
    return []
  }
}

export function verifyInvariants(original, out, seg, items) {
  const [a, b] = seg
  const channels = original.length
  for (const item of items) {
    for (let c = 0; c < channels; c++) {
      for (let k = 0; k < BLOCK_FRAMES; k++) {
        if (out[c][item.targetFrame + k] !== original[c][item.sourceFrame + k]) {
          return { ok: false, type: 'block', index: item.index, channel: c, k }
        }
      }
    }
  }
  let touched = null
  outer: for (let c = 0; c < channels; c++) {
    for (let i = 0; i < original[c].length; i++) {
      const protectedFrame = i < a + EDGE_FRAMES || i >= b - EDGE_FRAMES
      if (protectedFrame && out[c][i] !== original[c][i]) { touched = { channel: c, frame: i }; break outer }
    }
  }
  if (touched) return { ok: false, type: 'protected', ...touched }
  return { ok: true }
}

// 搬迁前可行性预查：几何 + 双路辨认 + 原声目标端 vs 源端包络。
export function previewFeasibility(input) {
  const { pcm, rate = 16000, segment, items, frequencies = null, tolerance = 0.05 } = input
  const seg = Array.isArray(segment) ? segment : [segment?.start, segment?.end]
  const geometry = validateGeometry({ segment: seg, items })
  let envelope = null
  if (geometry.ok) {
    let freqs = frequencies
    if (!Array.isArray(freqs) || freqs.length === 0) freqs = safeDetectFrequencies(pcm, seg[0], seg[1], rate, items)
    envelope = evaluateEnvelope({ reference: pcm, candidate: pcm, rate, segment: seg, items,
      frequencies: freqs, tolerance })
  }
  return { geometry, envelope }
}
