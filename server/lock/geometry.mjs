// 落锁搬迁的帧几何规则（全部零起算、半开区间 [start,end)）：
//  - 每个撞击搬 32 帧双路原码，构成一块“保护片”；
//  - 段首尾各 16 帧是保留区，任何源/目标保护片都不得侵入，更不得越段；
//  - 同源片之间、同目标片之间不得重叠（“各自”）；
//  - 目标片彼此之间、以及目标片与首尾保留区之间至少留 2 帧接声。
export const BLOCK_FRAMES = 32
export const EDGE_FRAMES = 16
export const JOIN_FRAMES = 2

export const sliceOf = (frame, block = BLOCK_FRAMES) => ({ start: frame, end: frame + block, frames: block })

export function isFrameNumber(value) {
  if (typeof value === 'string' && value.trim() !== '') value = Number(value)
  return Number.isSafeInteger(value) && value >= 0
}

export function gapFrames(firstEnd, secondStart) {
  return secondStart - firstEnd
}

function boundaryViolations(kind, frame, segment, index) {
  const [a, b] = segment
  const out = []
  if (!Number.isInteger(frame)) {
    out.push({ code: `${kind}-frame-invalid`, index, message: `第 ${index + 1} 个落锁的${kind === 'source' ? '源' : '目标'}帧不是整数帧。` })
    return out
  }
  const end = frame + BLOCK_FRAMES
  if (frame < a || end > b) {
    out.push({ code: `${kind}-out-of-segment`, index, message: `第 ${index + 1} 个落锁的${kind === 'source' ? '源保护片' : '目标片'}越出改动段。` })
    return out
  }
  if (frame < a + EDGE_FRAMES || end > b - EDGE_FRAMES) {
    out.push({ code: `${kind}-edge-intrusion`, index,
      message: `第 ${index + 1} 个落锁的${kind === 'source' ? '源保护片' : '目标片'}侵入段首尾各 ${EDGE_FRAMES} 帧保留区，请把圈选段放宽或重圈。` })
  }
  return out
}

// items: [{ sourceFrame?:number|null, targetFrame?:number|null }]
// options.requireSource / requireTarget 控制当前阶段必须具备的坐标。
export function validateGeometry({ segment, items = [], requireSource = true, requireTarget = true } = {}) {
  const violations = []
  const [a, b] = Array.isArray(segment) ? segment : [segment?.start, segment?.end]
  if (!Number.isInteger(a) || !Number.isInteger(b) || b <= a) {
    return { ok: false, violations: [{ code: 'segment-invalid', message: '改动段需要有效的零起算首尾帧。' }],
      sourceSlices: [], targetSlices: [] }
  }
  if (b - a < EDGE_FRAMES * 2 + BLOCK_FRAMES) {
    violations.push({ code: 'segment-too-short', message: `改动段至少要容纳首尾各 ${EDGE_FRAMES} 帧保留区和一块 ${BLOCK_FRAMES} 帧保护片。` })
  }

  const sourceSlices = []
  const targetSlices = []
  items.forEach((item, index) => {
    const s = item?.sourceFrame ?? item?.source ?? null
    const t = item?.targetFrame ?? item?.target ?? null
    if (requireSource) {
      if (!Number.isInteger(s)) violations.push({ code: 'source-missing', index, message: `第 ${index + 1} 个落锁尚未确认唯一源帧。` })
      else {
        violations.push(...boundaryViolations('source', s, [a, b], index))
        sourceSlices.push({ index, ...sliceOf(s) })
      }
    } else if (Number.isInteger(s)) {
      violations.push(...boundaryViolations('source', s, [a, b], index))
      sourceSlices.push({ index, ...sliceOf(s) })
    }
    if (requireTarget) {
      if (!Number.isInteger(t)) violations.push({ code: 'target-missing', index, message: `第 ${index + 1} 个落锁缺少目标帧。` })
      else {
        violations.push(...boundaryViolations('target', t, [a, b], index))
        // 与首尾保留区之间至少 2 帧接声（在 16 帧不侵入之上再加 2 帧净距）。
        const end = t + BLOCK_FRAMES
        if (t >= a + EDGE_FRAMES && t < a + EDGE_FRAMES + JOIN_FRAMES) {
          violations.push({ code: 'target-head-join', index,
            message: `第 ${index + 1} 个目标片与段首保留区之间至少留 ${JOIN_FRAMES} 帧接声。` })
        }
        if (end <= b - EDGE_FRAMES && b - EDGE_FRAMES - end < JOIN_FRAMES) {
          violations.push({ code: 'target-tail-join', index,
            message: `第 ${index + 1} 个目标片与段尾保留区之间至少留 ${JOIN_FRAMES} 帧接声。` })
        }
        targetSlices.push({ index, ...sliceOf(t) })
      }
    } else if (Number.isInteger(t)) {
      violations.push(...boundaryViolations('target', t, [a, b], index))
      targetSlices.push({ index, ...sliceOf(t) })
    }
  })

  // 同源保护片：按源帧排序后逐对检查不得重叠。
  const sortedSources = [...sourceSlices].sort((x, y) => x.start - y.start)
  for (let i = 1; i < sortedSources.length; i++) {
    const prev = sortedSources[i - 1], cur = sortedSources[i]
    if (gapFrames(prev.end, cur.start) < 0) {
      violations.push({ code: 'source-overlap', indexes: [prev.index, cur.index],
        message: `第 ${prev.index + 1}、${cur.index + 1} 个源保护片重叠，请重新圈开原声搜索范围。` })
    }
  }

  // 同目标片：不得重叠，且相邻片之间至少 2 帧接声。
  const sortedTargets = [...targetSlices].sort((x, y) => x.start - y.start)
  for (let i = 1; i < sortedTargets.length; i++) {
    const prev = sortedTargets[i - 1], cur = sortedTargets[i]
    const gap = gapFrames(prev.end, cur.start)
    if (gap < 0) violations.push({ code: 'target-overlap', indexes: [prev.index, cur.index],
      message: `第 ${prev.index + 1}、${cur.index + 1} 个目标片重叠。` })
    else if (gap < JOIN_FRAMES) violations.push({ code: 'target-join', indexes: [prev.index, cur.index],
      message: `第 ${prev.index + 1}、${cur.index + 1} 个目标片之间只有 ${gap} 帧，至少留 ${JOIN_FRAMES} 帧接声。` })
  }

  return { ok: violations.length === 0, violations, sourceSlices, targetSlices,
    limits: { blockFrames: BLOCK_FRAMES, edgeFrames: EDGE_FRAMES, joinFrames: JOIN_FRAMES } }
}

// 供 UI/报告使用：给定段长，返回合法目标帧闭区间（零起算）。
export function legalTargetRange(segment) {
  const [a, b] = Array.isArray(segment) ? segment : [segment?.start, segment?.end]
  return { min: a + EDGE_FRAMES + JOIN_FRAMES, max: b - EDGE_FRAMES - JOIN_FRAMES - BLOCK_FRAMES }
}
