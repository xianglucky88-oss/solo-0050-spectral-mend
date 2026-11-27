import { InputError } from '../http/error.mjs'
import { decodeAudioAny } from './decode-source.mjs'

// 工作台领域模型：
// - clip（源段）：原录音上零起算半开帧区间 [startFrame, endFrame)
// - take / occurrence（一次出场）：源段在拼接时间线上的一次放置，身份稳定
// - piece（分段）：同次出场内仅为定位而切出的连续段，共享 takeId
// - hard joint（硬切接头）：处理与谱图都不得跨越的边界
// 选框通过 takeId 绑定到“那次出场”，重排/互换后随出场移动。

let sequence = 0
export function freshId(prefix = 'id') {
  sequence += 1
  return `${prefix}${Date.now().toString(36)}${sequence}`
}

const TIMELINE_KEYS = ['timeline', 'items', 'placements', 'pieces', 'segments', 'takes',
  'blocks', 'arrangement', 'arrange', 'sequence', 'order', 'ordering', 'playlist',
  'montage', 'composition', 'board', 'trackItems', 'clipInstances', 'instances', 'clips']

const LIBRARY_KEYS = ['clips', 'clipLibrary', 'sources', 'sourceClips', 'ranges', 'library']

const START_FRAME_KEYS = ['startFrame', 'startFrames', 'frameStart', 'sourceStartFrame',
  'srcStartFrame', 'fromFrame', 'startSample', 'startSamples', 'sampleStart',
  'sourceStartSample', 'sourceFrame', 'sourceStart', 'srcStart', 'inFrame', 'fromSample', 'from']
const END_FRAME_KEYS = ['endFrame', 'endFrames', 'frameEnd', 'sourceEndFrame', 'srcEndFrame',
  'toFrame', 'endSample', 'endSamples', 'sampleEnd', 'sourceEndSample', 'sourceEnd', 'srcEnd',
  'outFrame', 'toSample', 'to']
const START_SEC_KEYS = ['startSeconds', 'startSec', 'startTime', 'start']
const END_SEC_KEYS = ['endSeconds', 'endSec', 'endTime', 'end']

const OWNER_KEYS = ['takeId', 'occurrenceId', 'appearanceId', 'instanceId', 'ownerId',
  'targetId', 'bindId', 'forId', 'segmentId', 'pieceId', 'clipInstanceId',
  'take', 'occurrence', 'appearance', 'owner', 'target', 'bind', 'boundTo', 'for']

function hasNumber(obj, keys) {
  for (const key of keys) {
    const value = obj?.[key]
    if (typeof value === 'number' && Number.isFinite(value)) return value
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  }
  return undefined
}

function digId(value) {
  if (value === null || value === undefined) return undefined
  if (typeof value === 'string' || typeof value === 'number') return String(value)
  if (typeof value === 'object') return value.id ?? value.takeId ?? value.occurrenceId ?? value.uuid ?? value.key
  return undefined
}

function unitSaysFrames(raw, input) {
  const unit = String(raw?.unit ?? raw?.units ?? raw?.coordinates ?? raw?.scale ??
    input?.unit ?? input?.units ?? input?.coordinates ?? '').toLowerCase()
  if (/frame|sample|帧/.test(unit)) return true
  if (/sec|time|秒/.test(unit)) return false
  return undefined
}

// 从一个对象/数组读取源帧区间；尽量兼容不同命名与秒/帧单位。
export function readFrameRange(raw, rate, totalFrames, input = {}) {
  if (Array.isArray(raw)) {
    if (raw.length >= 2 && typeof raw[0] === 'number' && typeof raw[1] === 'number') {
      return finalizeFrames(raw[0], raw[1], rate, totalFrames, true)
    }
  }
  if (!raw || typeof raw !== 'object') return undefined
  if (Array.isArray(raw.frames) && raw.frames.length >= 2) return finalizeFrames(raw.frames[0], raw.frames[1], rate, totalFrames, true)
  if (Array.isArray(raw.range) && raw.range.length >= 2) return finalizeFrames(raw.range[0], raw.range[1], rate, totalFrames, true)
  if (Array.isArray(raw.frameRange)) return finalizeFrames(raw.frameRange[0], raw.frameRange[1], rate, totalFrames, true)
  if (Array.isArray(raw.sourceRange)) return finalizeFrames(raw.sourceRange[0], raw.sourceRange[1], rate, totalFrames, true)
  if (Array.isArray(raw.src) && typeof raw.src[0] === 'number') return finalizeFrames(raw.src[0], raw.src[1], rate, totalFrames, true)

  const fs = hasNumber(raw, START_FRAME_KEYS)
  const fe = hasNumber(raw, END_FRAME_KEYS)
  if (fs !== undefined && fe !== undefined) return finalizeFrames(fs, fe, rate, totalFrames, true)

  const ss = hasNumber(raw, START_SEC_KEYS)
  const se = hasNumber(raw, END_SEC_KEYS)
  if (ss !== undefined && se !== undefined) {
    const frameFlag = unitSaysFrames(raw, input)
    if (frameFlag === true) return finalizeFrames(ss, se, rate, totalFrames, true)
    if (frameFlag === false) return finalizeFrames(Math.round(ss * rate), Math.round(se * rate), rate, totalFrames, true)
    // 裸 start/end：超出秒定义域的整数按帧，否则沿用既有“秒”契约。
    const duration = totalFrames / rate
    if (Number.isInteger(ss) && Number.isInteger(se) && se > duration + 1e-9) {
      return finalizeFrames(ss, se, rate, totalFrames, true)
    }
    return finalizeFrames(Math.round(ss * rate), Math.round(se * rate), rate, totalFrames, true)
  }
  return undefined
}

function finalizeFrames(start, end, rate, totalFrames, validate) {
  const s = Math.round(start), e = Math.round(end)
  if (validate && (!Number.isFinite(s) || !Number.isFinite(e) || s < 0 || e <= s ||
      (totalFrames && e > totalFrames))) {
    throw new InputError(`片段帧区间无效：[${start}, ${end})，源共 ${totalFrames} 帧。`)
  }
  return { startFrame: s, endFrame: e }
}

function isItemArray(value) {
  return Array.isArray(value) && value.every(entry =>
    (entry && typeof entry === 'object' && !ArrayBuffer.isView(entry)) || Array.isArray(entry) || typeof entry === 'string')
}

function unwrapInput(input) {
  if (input?.workbench && typeof input.workbench === 'object' && !Array.isArray(input.workbench)) {
    return { ...input, ...input.workbench, __outer: input }
  }
  if (input?.state && typeof input.state === 'object' && !Array.isArray(input.state) &&
      (input.state.items || input.state.timeline || input.state.clips)) {
    return { ...input, ...input.state, __outer: input }
  }
  return input
}

export function isWorkbenchInput(input) {
  if (!input || typeof input !== 'object') return false
  if (input.mode === 'workbench' || input.workbench === true) return true
  const root = unwrapInput(input)
  for (const key of TIMELINE_KEYS) if (isItemArray(root[key])) return true
  // 仅有 clips 且元素自带帧区间/引用时也视为工作台（有序片段）。
  if (isItemArray(root.clips) && root.clips.some(c => c && typeof c === 'object' &&
      (hasNumber(c, START_FRAME_KEYS) !== undefined || hasNumber(c, START_SEC_KEYS) !== undefined || c.clip || c.clipId))) {
    return true
  }
  return false
}

function buildClipLibrary(root, rate, totalFrames, input) {
  const map = new Map()
  let library = null
  for (const key of LIBRARY_KEYS) {
    if (root[key] && typeof root[key] === 'object') { library = root[key]; break }
  }
  if (!library) return map
  if (Array.isArray(library)) {
    library.forEach((clip, index) => {
      const id = String(digId(clip) ?? clip.id ?? `clip${index + 1}`)
      const range = readFrameRange(clip, rate, totalFrames, input)
      if (range) map.set(id, { id, ...range })
    })
  } else {
    for (const [id, clip] of Object.entries(library)) {
      if (Array.isArray(clip)) {
        const range = readFrameRange(clip, rate, totalFrames, input)
        if (range) map.set(id, { id, ...range })
      } else if (clip && typeof clip === 'object') {
        const range = readFrameRange(clip, rate, totalFrames, input)
        if (range) map.set(id, { id, ...range })
      }
    }
  }
  return map
}

function rawTimeline(root) {
  for (const key of TIMELINE_KEYS) if (isItemArray(root[key])) return { key, list: root[key] }
  if (isItemArray(root.clips)) return { key: 'clips', list: root.clips }
  return { key: null, list: [] }
}

function truthyHard(value) {
  return value === true || value === 1 || value === 'hard' || value === 'cut' || value === '硬切'
}

function hardFlag(raw) {
  if (truthyHard(raw.hard) || truthyHard(raw.hardCut) || raw.isHard === true || raw.isHardCut === true ||
      raw.hardJoint === true || truthyHard(raw.cut)) return true
  for (const key of ['seam', 'joint', 'transition', 'boundary']) {
    const value = raw[key]
    if (truthyHard(value) || (value && typeof value === 'object' && truthyHard(value.type ?? value.kind ?? value.hard))) {
      return true
    }
  }
  return false
}

// 把输入归一化为带稳定身份的片段/出场/分段列表（尚未计算布局）。
export function normalizeModel(input, audio) {
  const root = unwrapInput(input)
  const rate = audio.rate, totalFrames = audio.frames
  const clips = buildClipLibrary(root, rate, totalFrames, root)
  const { key: timelineKey, list } = rawTimeline(root)
  const defaultAllHard = root.allHardCuts ?? root.hardAll ?? root.everyJointHard ?? false

  const items = list.map((entry, index) => {
    let raw = entry
    if (typeof entry === 'string' || typeof entry === 'number') raw = { clip: entry }
    if (Array.isArray(entry)) {
      if (entry.length === 2 && typeof entry[0] === 'string') raw = { clip: entry[0], ...(entry[1] ?? {}) }
      else raw = { range: entry }
    }
    const pid = String(raw.id ?? raw.pid ?? raw.pieceId ?? raw.key ?? raw.uuid ??
      raw.clientId ?? `p${index + 1}`)
    let takeId = digId(pick(raw, OWNER_KEYS.filter(k => k !== 'segmentId' && k !== 'pieceId'))) ??
      digId(raw.takeId ?? raw.occurrenceId ?? raw.appearanceId ?? raw.instanceId ??
        raw.parentId ?? raw.parent ?? raw.splitOf ?? raw.rootId ?? raw.groupId ??
        raw.segmentId ?? raw.takeGroup) ?? pid
    takeId = String(takeId)

    let range = readFrameRange(raw, rate, totalFrames, root)
    const clipRef = digId(raw.clipId ?? raw.clip ?? raw.sourceId ?? raw.source ?? raw.ref ??
      raw.clipRef ?? raw.srcClip)
    let clip = null
    if (clipRef !== undefined && clips.has(String(clipRef))) clip = clips.get(String(clipRef))
    if (!range && clip) range = { startFrame: clip.startFrame, endFrame: clip.endFrame }
    if (!range && typeof raw.clip === 'object') range = readFrameRange(raw.clip, rate, totalFrames, root)
    const replacement = raw.replacement ?? raw.replace ?? raw.replacementWav ?? raw.replacementAudio ??
      raw.audio ?? raw.pcm ?? raw.sound ?? raw.wavOverride ??
      (raw.wav && raw.wav !== root.wav ? raw.wav : undefined)
    if (!range && replacement !== undefined) {
      // 只有替换音频时，区间由替换音频帧数决定。
      const replacementAudio = decodeAudioAny(replacement)
      range = { startFrame: 0, endFrame: replacementAudio.frames, replacementOnly: true }
    }
    if (!range) throw new InputError(`第 ${index + 1} 个工作台片段缺少帧区间或源段引用。`)

    // 显式方向优先；笼统的 hard:true 同时隔离两侧，兼容“此段为硬切”的两种表述。
    const afterExplicit = raw.hardAfter ?? raw.hardCutAfter ?? raw.cutAfter
    const beforeExplicit = raw.hardBefore ?? raw.hardCutBefore ?? raw.cutBefore
    const genericHard = hardFlag(raw) || defaultAllHard === true
    const hardAfter = afterExplicit === false ? false :
      (truthyHard(afterExplicit) || (afterExplicit === undefined && genericHard))
    const hardBefore = beforeExplicit === false ? false :
      (truthyHard(beforeExplicit) || (beforeExplicit === undefined && genericHard))

    return {
      pid,
      id: pid,
      takeId,
      clipId: clip?.id ?? (clipRef !== undefined ? String(clipRef) : null),
      startFrame: range.startFrame,
      endFrame: range.endFrame,
      replacementOnly: !!range.replacementOnly,
      replacement,
      hardAfter,
      hardBefore,
      label: raw.label ?? raw.name ?? null,
      _index: index
    }
  })

  if (!items.length) throw new InputError('工作台至少需要一个片段。')

  // hardBefore 折算到前一个片段的 hardAfter。
  for (let i = 0; i < items.length; i++) {
    if (items[i].hardBefore && i > 0) items[i - 1].hardAfter = true
  }
  applyTopLevelReplacements(root, items)

  const model = { root, audio, rate, sourceFrames: totalFrames, clips, items, timelineKey }
  applyTopLevelCuts(model)
  model.layout = compileLayout(model)
  model.regions = normalizeRegions(model)
  return model
}

function pick(obj, keys) {
  for (const key of keys) if (obj?.[key] !== undefined) return obj[key]
  return undefined
}

// 顶层 replacements：{ [takeOrItemId]: wavBase64 }、与 items 对齐的数组，或单个音频。
function applyTopLevelReplacements(root, items) {
  const map = root.replacements ?? root.replacementAudio ?? root.replacementWavs ??
    root.dubs ?? root.overdubs ?? root.replace
  if (map === undefined || map === null) return
  if (Array.isArray(map)) {
    map.forEach((value, index) => {
      if (value === undefined || value === null) return
      const target = items[index]
      if (target) target.replacement = typeof value === 'object' && value.wav ? value.wav : value
    })
    return
  }
  if (typeof map === 'string') {
    if (items[0]) items[0].replacement = map
    return
  }
  if (typeof map === 'object') {
    for (const [key, value] of Object.entries(map)) {
      const payload = typeof value === 'object' && value !== null && !ArrayBuffer.isView(value) && 'wav' in value ? value.wav : value
      const target = items.find(i => i.pid === key || i.takeId === key || i.clipId === key)
      if (target) target.replacement = payload
    }
  }
}

function applyTopLevelCuts(model) {
  const { root, items } = model
  const groups = [root.hardCuts, root.hardcuts, root.hardCut, root.hardJoints, root.joints,
    root.seams, root.cuts, root.boundaries, root.hardBoundaries]
  const specs = groups.find(g => Array.isArray(g))
  if (!specs) return
  const byId = new Map(items.map(i => [i.pid, i]))
  const takeToItems = new Map()
  for (const it of items) {
    if (!takeToItems.has(it.takeId)) takeToItems.set(it.takeId, [])
    takeToItems.get(it.takeId).push(it)
  }
  const markAfter = token => {
    if (token === undefined || token === null) return
    if (typeof token === 'number' && Number.isInteger(token)) {
      if (token >= 0 && token < items.length) items[token].hardAfter = true
      else markFrame(token)
      return
    }
    const id = String(token)
    if (byId.has(id)) { byId.get(id).hardAfter = true; return }
    if (takeToItems.has(id)) {
      const list = takeToItems.get(id)
      list[list.length - 1].hardAfter = true
    }
  }
  const markBefore = token => {
    if (typeof token === 'number' && Number.isInteger(token)) {
      if (token > 0 && token <= items.length) items[token - 1].hardAfter = true
      return
    }
    const id = String(token)
    const item = byId.get(id) ?? takeToItems.get(id)?.[0]
    if (item) {
      const index = items.indexOf(item)
      if (index > 0) items[index - 1].hardAfter = true
    }
  }
  const markFrame = frame => {
    // 延迟到布局后：找到结束帧恰好等于该位置的片段。
    model._frameCuts = model._frameCuts || []
    model._frameCuts.push(frame)
  }
  for (const spec of specs) {
    if (typeof spec === 'number' || typeof spec === 'string') { markAfter(spec); continue }
    if (!spec || typeof spec !== 'object') continue
    if (spec.hard === false || spec.type === 'soft' || spec.kind === 'soft') continue
    if (spec.after !== undefined) markAfter(spec.after)
    if (spec.before !== undefined) markBefore(spec.before)
    if (spec.at !== undefined || spec.frame !== undefined || spec.framePosition !== undefined) {
      markFrame(Number(spec.at ?? spec.frame ?? spec.framePosition))
    }
    if (Array.isArray(spec.between) && spec.between.length === 2) {
      const [a, b] = spec.between.map(x => String(x))
      const ia = items.findIndex(i => i.pid === a || i.takeId === a)
      const ib = items.findIndex(i => i.pid === b || i.takeId === b)
      if (ia >= 0 && ib >= 0) items[Math.min(ia, ib)].hardAfter = true
    }
  }
}

// 计算时间线帧偏移、出场跨度与硬切处理跨度。
export function compileLayout(model) {
  const { items } = model
  let offset = 0
  for (const item of items) {
    item.frameStart = offset
    item.length = Math.max(0, item.endFrame - item.startFrame)
    item.frameEnd = offset + item.length
    offset = item.frameEnd
  }
  // 基于时间线帧位置的硬切标记。
  if (model._frameCuts) {
    for (const frame of model._frameCuts) {
      const at = items.findIndex(i => i.frameEnd === frame)
      if (at >= 0 && at < items.length - 1) items[at].hardAfter = true
    }
  }
  const totalFrames = offset

  const takeMap = new Map()
  for (const item of items) {
    if (!takeMap.has(item.takeId)) {
      takeMap.set(item.takeId, { takeId: item.takeId, frameStart: item.frameStart,
        frameEnd: item.frameEnd, items: [], clipId: item.clipId })
    }
    const take = takeMap.get(item.takeId)
    take.frameStart = Math.min(take.frameStart, item.frameStart)
    take.frameEnd = Math.max(take.frameEnd, item.frameEnd)
    take.items.push(item.pid)
  }
  const takes = [...takeMap.values()].map(t => ({ ...t, length: t.frameEnd - t.frameStart,
    start: t.frameStart / model.rate, end: t.frameEnd / model.rate }))

  const spans = []
  let current = null
  for (const [index, item] of items.entries()) {
    if (!current) {
      current = { index: spans.length, pids: [], frameStart: item.frameStart, frameEnd: item.frameEnd }
      spans.push(current)
    }
    current.pids.push(item.pid)
    current.frameEnd = item.frameEnd
    if (item.hardAfter && index < items.length - 1) current = null
  }
  for (const span of spans) {
    span.length = span.frameEnd - span.frameStart
    span.start = span.frameStart / model.rate
    span.end = span.frameEnd / model.rate
  }
  const boundaries = items.slice(0, -1).map((item, i) => ({
    after: item.pid, before: items[i + 1].pid, frame: item.frameEnd,
    hard: !!item.hardAfter
  }))
  return { totalFrames, takes, spans, boundaries }
}

function resolveOwner(raw, model) {
  const id = digId(pick(raw, OWNER_KEYS))
  if (id !== undefined) {
    const key = String(id)
    if (/^\d+$/.test(key)) {
      let index = Number(key)
      if (!model.items[index] && index >= 1 && model.items[index - 1]) index -= 1 // 兼容 1 起算
      const byOrder = model.items[index]
      if (byOrder) return { takeId: byOrder.takeId, pieceId: byOrder.pid, origin: 'take' }
    }
    const take = model.layout.takes.find(t => t.takeId === key)
    if (take) return { takeId: key, origin: 'take' }
    const piece = model.items.find(i => i.pid === key)
    if (piece) {
      // 若该 id 同时是出场 id 已在上面处理；否则按分段自身起点定位。
      return { takeId: piece.takeId, pieceId: piece.pid, origin: 'piece' }
    }
    // 可能直接给了源段 id 并附带“第几次复用”。
    const ordinalOwner = ownerBySourceOrdinal(raw, model, key)
    if (ordinalOwner) return ordinalOwner
    // 找不到也保留绑定身份（可能 UI 稍后补齐），按全局回退。
    return { takeId: key, origin: 'missing' }
  }
  const ordinalOwner = ownerBySourceOrdinal(raw, model)
  if (ordinalOwner) return ordinalOwner
  return { takeId: null, origin: 'global' }
}

function ownerBySourceOrdinal(raw, model, forcedClip) {
  const clipRef = forcedClip ?? digId(raw.clip ?? raw.clipId ?? raw.sourceClip ?? raw.source)
  const ordinalRaw = raw.occurrence ?? raw.occurrenceIndex ?? raw.appearance ?? raw.takeIndex ??
    raw.reuseIndex ?? raw.nth ?? raw.ordinal ?? raw.index
  if (clipRef === undefined && ordinalRaw === undefined) return null
  let matches = model.items
  if (clipRef !== undefined) {
    const key = String(clipRef)
    matches = model.items.filter(i => String(i.clipId ?? i.clip ?? i.source ?? '') === key ||
      (i.startFrame !== undefined && model.clips.get?.(key) &&
        i.startFrame === model.clips.get(key).startFrame && i.endFrame === model.clips.get(key).endFrame))
  }
  if (!matches.length) return null
  if (ordinalRaw === undefined) {
    // 指定了源段但没给次序：若只有一次直接用，否则无法消歧，返回最后一次（常见“后一次”）。
    const item = matches.length === 1 ? matches[0] : matches[matches.length - 1]
    return { takeId: item.takeId, origin: 'take' }
  }
  const n = Number(ordinalRaw)
  const ordinalKey = ['occurrenceIndex', 'takeIndex', 'reuseIndex', 'index'].find(k => raw[k] !== undefined)
  // *Index/index 按零起算；occurrence/nth/ordinal 按一起算。两种越界时互相回退。
  let item = ordinalKey ? (matches[n] ?? matches[n - 1]) : (matches[n - 1] ?? matches[n])
  if (!item) return null
  return { takeId: item.takeId, origin: 'take' }
}

export function normalizeRegions(model) {
  const rawList = model.root.regions ?? model.root.boxes ?? model.root.selections ??
    model.root.masks ?? (model.root.region ? [model.root.region] : [])
  const list = Array.isArray(rawList) ? rawList : []
  if (list.length > 8) throw new InputError('最多可以叠加 8 个频谱选区。')
  return list.map((raw, index) => {
    if (!raw || typeof raw !== 'object') throw new InputError('频谱选区格式无效。')
    const id = String(raw.id ?? raw.regionId ?? raw.boxId ?? `r${index + 1}`)
    const low = Number(raw.low ?? raw.lowHz ?? raw.fLow ?? raw.freqLow ?? raw.band?.[0] ??
      (Array.isArray(raw.freq) ? raw.freq[0] : undefined))
    const high = Number(raw.high ?? raw.highHz ?? raw.fHigh ?? raw.freqHigh ?? raw.band?.[1] ??
      (Array.isArray(raw.freq) ? raw.freq[1] : undefined))
    const db = Number(raw.db ?? raw.dbAmount ?? raw.attenuation ?? raw.attenuationDb ??
      raw.cutDb ?? raw.amount ?? raw.decibels ?? 18)
    if (![low, high, db].every(Number.isFinite) || low < 0 || high <= low ||
        high > model.rate / 2 + 1e-6 || db < 0 || db > 60) {
      throw new InputError('频谱选区需要有效的频带与 0–60 dB 衰减。')
    }
    const owner = resolveOwner(raw, model)
    // 直接用通用读取器：显式 *Frame/*Sample 键按帧，裸 start/end 沿用既有“秒”契约，
    // unit 显式声明或数值超出秒定义域时按帧。得到的是“绑定出场/全局”的局部帧。
    const range = readFrameRange(raw, model.rate, model.layout.totalFrames, model.root)
    if (!range) throw new InputError('频谱选区需要有效的开始与结束。')
    const localStartFrame = range.startFrame
    const localEndFrame = range.endFrame

    let globalStartFrame, globalEndFrame
    if (owner.origin === 'take') {
      const take = model.layout.takes.find(t => t.takeId === owner.takeId)
      globalStartFrame = take.frameStart + localStartFrame
      globalEndFrame = take.frameStart + localEndFrame
    } else if (owner.origin === 'piece') {
      const piece = model.items.find(i => i.pid === owner.pieceId)
      globalStartFrame = piece.frameStart + localStartFrame
      globalEndFrame = piece.frameStart + localEndFrame
    } else {
      globalStartFrame = localStartFrame
      globalEndFrame = localEndFrame
    }
    if (globalStartFrame < 0 || globalEndFrame <= globalStartFrame ||
        globalEndFrame > model.layout.totalFrames + Math.ceil(model.rate * 0.001)) {
      // 允许贴尾的微小误差，否则拒绝。
      if (globalEndFrame > model.layout.totalFrames) {
        throw new InputError('频谱选区超出拼接时长。')
      }
    }
    return {
      id, regionId: id, takeId: owner.takeId, owner: owner.takeId,
      origin: owner.origin, low, high, db,
      localStartFrame, localEndFrame,
      startFrame: globalStartFrame, endFrame: Math.min(globalEndFrame, model.layout.totalFrames),
      start: globalStartFrame / model.rate, end: Math.min(globalEndFrame, model.layout.totalFrames) / model.rate
    }
  })
}

// 给界面/程序化调用：返回选框在拼接时间线上的解析结果。
export function resolveBoxes(model) {
  const duration = model.layout.totalFrames / model.rate
  return model.regions.map(r => ({
    id: r.id, regionId: r.id, takeId: r.takeId, owner: r.takeId,
    start: r.start, end: r.end, low: r.low, high: r.high, db: r.db,
    startFrame: r.startFrame, endFrame: r.endFrame,
    x0: duration ? r.start / duration : 0, x1: duration ? r.end / duration : 0
  }))
}

// ---- 纯状态操作（界面与程序化检查共用；直接返回新的普通状态对象）----

export function createState(partial = {}) {
  return {
    clips: partial.clips ?? [],
    items: partial.items ?? [],
    regions: partial.regions ?? [],
    hardCuts: partial.hardCuts ?? [],
    size: partial.size ?? 512,
    ...partial
  }
}

export function cutClip(state, range = {}) {
  const id = range.id ?? freshId('A')
  const clip = { id, startFrame: Math.round(range.startFrame ?? range.start ?? 0),
    endFrame: Math.round(range.endFrame ?? range.end ?? 0), label: range.label ?? null }
  return { ...state, clips: [...state.clips.filter(c => c.id !== id), clip] }
}

export function placeClip(state, clipId, options = {}) {
  const clip = state.clips.find(c => c.id === clipId)
  const item = {
    id: options.id ?? freshId('t'),
    takeId: options.takeId ?? options.occurrenceId ?? options.id ?? freshId('t'),
    clip: clipId,
    startFrame: options.startFrame ?? clip?.startFrame,
    endFrame: options.endFrame ?? clip?.endFrame,
    hard: !!options.hard,
    label: options.label ?? null
  }
  return { ...state, items: [...state.items, item] }
}

export function reorderItems(state, from, to) {
  const items = [...state.items]
  const [moved] = items.splice(from, 1)
  items.splice(to, 0, moved)
  return { ...state, items }
}

// 互换两次出场：交换它们在时间线上的位置；选区绑定 takeId，因此随出场移动。
export function swapAppearances(state, a, b) {
  const items = [...state.items]
  const ia = typeof a === 'number' ? a : items.findIndex(i => i.id === a || i.takeId === a)
  const ib = typeof b === 'number' ? b : items.findIndex(i => i.id === b || i.takeId === b)
  if (ia < 0 || ib < 0 || ia === ib) throw new InputError('互换需要两个不同的出场。')
  const takeA = items[ia].takeId, takeB = items[ib].takeId
  // 交换“位置”：把两个出场对应的连续块整体交换。
  const blockA = blockRange(items, ia), blockB = blockRange(items, ib)
  if (blockA[0] === blockB[0]) {
    ;[items[ia], items[ib]] = [items[ib], items[ia]]
  } else {
    const spanA = items.slice(blockA[0], blockA[1])
    const spanB = items.slice(blockB[0], blockB[1])
    const next = []
    for (let i = 0; i < items.length;) {
      if (i === blockA[0]) { next.push(...spanB); i = blockA[1] }
      else if (i === blockB[0]) { next.push(...spanA); i = blockB[1] }
      else { next.push(items[i]); i++ }
    }
    items.length = 0; items.push(...next)
  }
  return { ...state, items }
}

function blockRange(items, index) {
  const takeId = items[index].takeId
  let start = index, end = index + 1
  while (start > 0 && items[start - 1].takeId === takeId) start--
  while (end < items.length && items[end].takeId === takeId) end++
  return [start, end]
}

// 取片段在源录音上的有效帧区间：优先显式帧，否则回溯源段库。
function effectiveRange(state, item) {
  if (Number.isFinite(item.startFrame) && Number.isFinite(item.endFrame)) {
    return { startFrame: item.startFrame, endFrame: item.endFrame }
  }
  const ref = item.clip ?? item.clipId ?? item.source ?? item.sourceId
  const clip = (state.clips ?? []).find(c => c.id === ref)
  if (clip && Number.isFinite(clip.startFrame) && Number.isFinite(clip.endFrame)) {
    return { startFrame: clip.startFrame, endFrame: clip.endFrame }
  }
  return null
}

// 仅为定位，把同次出场内在 atFrame（默认出场内局部帧）切成连续两段。
export function splitAppearance(state, target, atFrame, options = {}) {
  const index = typeof target === 'number' ? target : state.items.findIndex(i => i.id === target || i.takeId === target)
  if (index < 0) throw new InputError('找不到要分段的出场。')
  const source = state.items[index]
  const range = effectiveRange(state, source)
  if (!range) throw new InputError('该出场缺少可分段的帧区间。')
  const { startFrame, endFrame } = range
  const splitAtSource = options.relative === 'source'
    ? Math.round(atFrame)
    : startFrame + Math.round(atFrame)
  if (splitAtSource <= startFrame || splitAtSource >= endFrame) {
    throw new InputError('分段帧必须落在片段内部。')
  }
  const sharedTake = source.takeId ?? source.id
  const outgoingHard = source.hardAfter === true || source.hard === true
  const rightId = freshId('p')
  const left = { ...source, takeId: sharedTake, startFrame, endFrame: splitAtSource,
    hard: false, hardAfter: false }
  const right = { ...source, id: rightId, takeId: sharedTake,
    startFrame: splitAtSource, endFrame, hard: outgoingHard, hardAfter: outgoingHard, hardBefore: false }
  const items = [...state.items]
  items.splice(index, 1, left, right)
  // 状态层 hardCuts 若以原 id 标记“该段之后”，迁移到右段（出场末端），
  // 使仅为定位的内部分段不改变硬切结构。
  let hardCuts = state.hardCuts
  if (Array.isArray(hardCuts) && hardCuts.includes(source.id)) {
    hardCuts = hardCuts.filter(x => x !== source.id).concat(rightId)
  }
  return { ...state, items, hardCuts }
}

export function setHardCut(state, afterTarget, hard = true) {
  const items = state.items.map(i => ({ ...i }))
  const index = typeof afterTarget === 'number' ? afterTarget
    : items.findIndex(i => i.id === afterTarget || i.takeId === afterTarget)
  if (index < 0 || index >= items.length) throw new InputError('找不到接头位置。')
  items[index].hard = hard
  items[index].hardAfter = hard
  const hardCuts = hard
    ? [...new Set([...(state.hardCuts ?? []), items[index].id])]
    : (state.hardCuts ?? []).filter(x => x !== items[index].id && x !== index)
  return { ...state, items, hardCuts }
}

export function replaceAudio(state, target, replacement) {
  const items = state.items.map(i => ({ ...i }))
  const index = typeof target === 'number' ? target : items.findIndex(i => i.id === target || i.takeId === target)
  if (index < 0) throw new InputError('找不到要替换声音的片段。')
  items[index].wav = replacement
  items[index].replacement = replacement
  return { ...state, items }
}

export function addRegion(state, region) {
  if ((state.regions ?? []).length >= 8) throw new InputError('最多保留 8 个选区。')
  return { ...state, regions: [...(state.regions ?? []), { id: freshId('r'), ...region }] }
}
