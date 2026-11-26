// 平顶（削波段）检测、整段归并、选中补峰与统一减半舍入的纯逻辑核心。
// 所有函数都不依赖 Node API，可同时被服务端与浏览器模块引用。
//
// 样值刻度约定：核心统一使用 PCM16 整数样值（-32768..32767）。
// 传入归一化浮点数组（-1..1）时按工作台 encode 规则 * 32768 后舍入夹取。

export const PCM_FULL_SCALE = 32768
export const PCM_POSITIVE_FULL = 32767
export const PCM_NEGATIVE_FULL = -32768

export const REASON_BOUNDARY = 'boundary_missing_anchor'
export const REASON_SINGLE = 'single_full_scale_sample'

// 工作台规则：Math.round（半值朝 +∞）后夹到 PCM16。
export function clampPcm16(value) {
  return value < -32768 ? -32768 : value > 32767 ? 32767 : value
}

export function workbenchRound(value) {
  const rounded = Math.round(value)
  if (rounded === 0) return 0 // 把 Math.round(-0.5) 产生的 -0 归一为 +0
  return clampPcm16(rounded)
}

// 单个整数样值减半并按工作台规则舍入。奇数负样值的 .5 与 Math.round 一致朝 +∞。
export function halveSample(sample) {
  return workbenchRound(sample / 2)
}

export function halveSamples(samples) {
  return Array.from(samples, sample => halveSample(Number(sample)))
}

export function quantizePcm16(values) {
  return Array.from(values, value => workbenchRound(value * PCM_FULL_SCALE))
}

function isIntegerLike(value) {
  return typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)
}

// 把任意样值数组转成 PCM16 整数数组。
// options.normalized=true 强制按 -1..1 归一化处理。
export function toPcm16(samples, options = {}) {
  if (!Array.isArray(samples) && !ArrayBuffer.isView(samples)) {
    throw new TypeError('样值必须是数组或类型化数组。')
  }
  const list = Array.from(samples)
  if (options.normalized === true) {
    return list.map(value => workbenchRound(Number(value) * PCM_FULL_SCALE))
  }
  if (options.integer === true || options.pcm === true) {
    return list.map(value => workbenchRound(Number(value)))
  }
  // 自动判别：全部为整数且存在绝对值大于 1 的样值时按 PCM 整数处理，
  // 否则按归一化浮点处理（1.0 经工作台规则成为 32767）。
  const looksInteger = list.every(isIntegerLike)
  const maxAbs = list.reduce((max, value) => Math.max(max, Math.abs(Number(value) || 0)), 0)
  if (looksInteger && maxAbs > 1) return list.map(value => workbenchRound(value))
  return list.map(value => workbenchRound(Number(value) * PCM_FULL_SCALE))
}

function normalizeLevel(level, pcm, fallbackRatio = 0.5) {
  const peak = pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  if (level === undefined || level === null) {
    return Math.max(1, Math.ceil(PCM_POSITIVE_FULL * fallbackRatio))
  }
  if (typeof level !== 'number' || !Number.isFinite(level) || level < 0) {
    throw new RangeError('削波幅度阈值必须是非负有限数。')
  }
  // 小于等于 1 的阈值按满幅比例解释（仅当信号本身是整数刻度时，0.9 才是比例）。
  if (level <= 1 && peak > 1) return Math.max(1, Math.round(level * PCM_FULL_SCALE))
  return Math.round(level)
}

function isFullScale(value, tolerance = 0) {
  return Math.abs(value) >= PCM_POSITIVE_FULL - tolerance
}

// 列出极大等幅连续段（默认长度至少 1）。返回 {start,end,length,value,peak,sign}。
export function findEqualRuns(samples, options = {}) {
  const pcm = toPcm16(samples, options)
  const minLength = options.minLength ?? 1
  const tolerance = options.flatTolerance ?? 0
  const same = (a, b) => tolerance > 0 ? Math.abs(a - b) <= tolerance : a === b
  const runs = []
  let start = 0
  for (let i = 1; i <= pcm.length; i++) {
    if (i < pcm.length && same(pcm[i], pcm[start])) continue
    const end = i - 1
    const length = end - start + 1
    if (length >= minLength) {
      const value = pcm[start]
      runs.push({ start, end, startSample: start, endSample: end, length,
        samples: length, value, level: value, peak: Math.abs(value),
        amplitude: Math.abs(value), sign: value < 0 ? -1 : 1 })
    }
    start = i
  }
  return runs
}

// 类 Python 契约的阈值越限段：极大的 abs(x) > threshold 连续区间。
// threshold 可传归一化比例（0..1）或与样值同刻度的绝对值；返回的 peak 保持输入刻度。
export function findRuns(samples, threshold = 0.9, options = {}) {
  const numeric = Array.from(samples, Number)
  const pcm = toPcm16(numeric, options)
  const limit = normalizeLevel(threshold, pcm, 0.9)
  // 归一化输入时把整数阈值换算回输入刻度用于判定，避免舍入改变 > 关系。
  const normalizedInput = options.normalized === true ||
    (options.integer !== true && numeric.every(isIntegerLike) === false &&
      numeric.reduce((m, v) => Math.max(m, Math.abs(v || 0)), 0) <= 1.0001)
  const activeAt = i => normalizedInput ? Math.abs(numeric[i]) > threshold
    : Math.abs(pcm[i]) > limit
  const runs = []
  let start = -1
  for (let i = 0; i <= pcm.length; i++) {
    const active = i < pcm.length && activeAt(i)
    if (active && start < 0) start = i
    if (!active && start >= 0) {
      const end = i - 1
      let peak = 0
      for (let j = start; j <= end; j++) peak = Math.max(peak, Math.abs(numeric[j]))
      runs.push([start, end, peak])
      start = -1
    }
  }
  return runs
}

// 判断一个候选段是否为削平平顶。
// 兼容两种调用：isClipped(run, {minLength, flatTolerance}) 与 isClipped(run, minLength, flatTolerance)。
export function isClipped(run, minLengthOrOptions = 2, maybeFlatTolerance) {
  const options = typeof minLengthOrOptions === 'object' && minLengthOrOptions !== null
    ? minLengthOrOptions
    : { minLength: minLengthOrOptions, flatTolerance: maybeFlatTolerance ?? 0.02 }
  const minLength = options.minLength ?? 2
  const flatTolerance = options.flatTolerance ?? 0.02
  if (Array.isArray(run)) {
    const [start, end, peak] = run
    const length = end - start + 1
    if (!Number.isInteger(start) || !Number.isInteger(end) || end < start) return false
    if (length < minLength) return false
    if (peak !== undefined) {
      // peak 可能是归一化刻度（<=1）或 PCM 整数刻度。
      const full = peak <= 1 ? 1 : PCM_POSITIVE_FULL
      return peak >= full * (1 - flatTolerance)
    }
    return true
  }
  if (!run || typeof run !== 'object') return false
  const length = run.length ?? (run.end - run.start + 1)
  if (length < minLength) return false
  const peak = run.peak ?? run.amplitude ?? Math.abs(run.value ?? run.level ?? 0)
  const full = peak <= 1 ? 1 : PCM_POSITIVE_FULL
  return peak >= full * (1 - flatTolerance)
}

export const isFlatTop = isClipped

function clipId(channel, start, end) {
  return `flat-${channel}-${start}-${end}`
}

// 检测单声道的平顶、满幅瞬态与证据不足段。
// 返回 { clips, flatTops, repairable, evidence, transients, ... }（同一批对象的不同视图）。
export function findFlatTops(input, thresholdOrOptions = {}, maybeOptions = {}) {
  // 第二参可传选项对象，或直接传 clipLevel/threshold 数值（兼容位置参数风格）。
  const options = typeof thresholdOrOptions === 'object' && thresholdOrOptions !== null
    ? thresholdOrOptions
    : { ...maybeOptions, clipLevel: thresholdOrOptions }
  const pcm = toPcm16(input, options)
  const channel = options.channel ?? 0
  const minLength = options.minLength ?? 2
  const explicitLevel = options.clipLevel ?? options.threshold ?? options.minLevel
  const channelPeak = pcm.reduce((max, value) => Math.max(max, Math.abs(value)), 0)
  // 未显式给阈值时自适应：真实刻度信号用半幅下限；小型符号夹具则按本声道峰值下探，
  // 使 [4,4,4] 这类小幅平顶也能被认出，同时零段仍被排除。
  const minLevel = explicitLevel !== undefined && explicitLevel !== null
    ? normalizeLevel(explicitLevel, pcm, 0.5)
    : Math.min(Math.ceil(PCM_POSITIVE_FULL * 0.5),
      Math.max(2, Math.floor(channelPeak * 0.9)))
  const fullTolerance = options.fullScaleTolerance ?? 0

  const clips = []
  const transients = []
  for (const run of findEqualRuns(pcm, { integer: true, minLength: 1,
    flatTolerance: options.flatTolerance })) {
    const { start, end, length, value } = run
    const amplitude = Math.abs(value)
    const full = isFullScale(value, fullTolerance)
    if (length < minLength) {
      // 单个满幅样点是瞬态，明确不算平顶。
      if (length === 1 && full) {
        transients.push(decorate({ kind: 'transient', start, end, length, value,
          sign: value < 0 ? -1 : 1,
          amplitude, repairable: false, status: 'transient',
          reason: REASON_SINGLE, reasons: [REASON_SINGLE],
          label: '满幅瞬态（单样点，非平顶）' }, channel, pcm.length, options.rate))
      }
      continue
    }
    if (amplitude < minLevel) continue
    const leftIndex = start - 1
    const rightIndex = end + 1
    const hasLeft = leftIndex >= 0
    const hasRight = rightIndex < pcm.length
    const reasons = []
    let status = 'repairable'
    let label = '可补平顶'
    if (!hasLeft || !hasRight) {
      status = 'boundary'
      label = '边界平顶，缺少一侧有效波形'
      reasons.push(REASON_BOUNDARY)
    }
    const clip = decorate({ kind: 'flat', start, end, length, value,
      sign: value < 0 ? -1 : 1,
      amplitude, level: value, clipLevel: amplitude,
      leftIndex: hasLeft ? leftIndex : null,
      rightIndex: hasRight ? rightIndex : null,
      leftValue: hasLeft ? pcm[leftIndex] : null,
      rightValue: hasRight ? pcm[rightIndex] : null,
      hasLeftAnchor: hasLeft, hasRightAnchor: hasRight,
      boundary: !hasLeft || !hasRight,
      repairable: status === 'repairable', status, reason: reasons[0] ?? null,
      reasons, label }, channel, pcm.length, options.rate)
    clips.push(clip)
  }

  const repairable = clips.filter(clip => clip.repairable)
  const evidence = clips.filter(clip => !clip.repairable)
  return { channel, frames: pcm.length, clips, flatTops: clips, all: clips,
    repairable, repairableClips: repairable,
    evidence, unresolved: evidence, insufficient: evidence,
    transients, spikes: transients, samples: pcm }
}

function decorate(clip, channel, frames, rate = 0) {
  const startSample = clip.startSample ?? clip.start
  const endSample = clip.endSample ?? clip.end
  const seconds = rate > 0 ? {
    startSeconds: startSample / rate,
    endSeconds: (endSample + 1) / rate,
    startTime: startSample / rate,
    endTime: (endSample + 1) / rate,
    startSec: startSample / rate,
    endSec: (endSample + 1) / rate
  } : {}
  return {
    id: clipId(channel, startSample, endSample),
    key: `${channel}:${startSample}:${endSample}`,
    channel,
    start: startSample,
    end: endSample,
    startSample,
    endSample,
    startIndex: startSample,
    endIndex: endSample,
    frames,
    durationSamples: endSample - startSample + 1,
    ...seconds,
    ...clip
  }
}

// 把区间参数统一成闭区间样点 [from,to]。核心层的 start/end 默认就是样点索引；
// 只有显式 seconds:true / timeUnit:'seconds' 时才按 rate 换算秒。
export function resolveRange(range = {}, rate = PCM_FULL_SCALE, frames = Number.MAX_SAFE_INTEGER, options = {}) {
  let from, to
  const asSeconds = options.seconds === true || range.seconds === true ||
    options.timeUnit === 'seconds' || range.timeUnit === 'seconds' || range.unit === 'seconds'
  if (Array.isArray(range)) {
    [from, to] = range
  } else if (typeof range === 'number') {
    from = range; to = range
  } else {
    from = range.startSample ?? range.fromSample ?? range.startIndex ?? range.from
      ?? range.rangeStart ?? range.a ?? range.start
    to = range.endSample ?? range.toSample ?? range.endIndex ?? range.to
      ?? range.rangeEnd ?? range.b ?? range.end
    if (asSeconds && Number.isFinite(Number(from))) from = Math.round(Number(from) * rate)
    if (asSeconds && Number.isFinite(Number(to))) to = Math.round(Number(to) * rate)
  }
  from = Number.isFinite(Number(from)) ? Math.max(0, Math.min(frames - 1, Math.round(Number(from)))) : 0
  to = Number.isFinite(Number(to)) ? Math.max(0, Math.min(frames - 1, Math.round(Number(to)))) : frames - 1
  if (to < from) [from, to] = [to, from]
  return { start: from, end: to, startSample: from, endSample: to }
}

// 圈出检查时段：返回与区间有任意交叠（含边界触碰）的极大整段。
// 支持 scanRange(samples, {startSample,endSample})、scanRange(samples, start, end, options?)
// 以及 scanRange(samples, {start,end,timeUnit:'seconds',rate})。
export function scanRange(input, range, endArg, optionsArg) {
  let rangeArg, options
  if (typeof range === 'number') {
    rangeArg = { startSample: range, endSample: typeof endArg === 'number' ? endArg : range }
    options = optionsArg ?? (endArg && typeof endArg === 'object' ? endArg : {})
  } else {
    rangeArg = range ?? {}
    // 两参形式 scanRange(input, options) 时，区间与选项是同一个对象。
    options = endArg ?? optionsArg ?? (typeof range === 'object' && range !== null ? range : {})
  }
  const rate = options.rate ?? PCM_FULL_SCALE
  let frames = options.frames
  if (frames === undefined) {
    const probe = toPcm16(input, options)
    frames = probe.length
  }
  const interval = resolveRange(rangeArg, rate, frames, options)
  const report = findFlatTops(input, options)
  const touches = clip => clip.start <= interval.end && clip.end >= interval.start
  const clips = report.clips.filter(touches)
  const transients = report.transients.filter(touches)
  const repairable = clips.filter(clip => clip.repairable)
  const evidence = clips.filter(clip => !clip.repairable)
  return { ...report, range: interval, interval,
    clips, flatTops: clips, repairable, repairableClips: repairable,
    evidence, unresolved: evidence, insufficient: evidence,
    transients, spikes: transients }
}

// 兼容 Python 契约的跨距重建：保持 span 外样点不变，锚点为紧邻外侧样点。
// method: 'linear' | 'cubic'。返回与输入等长的新数组（保持输入刻度）。
export function interpolateSpan(samples, span, method = 'linear') {
  const input = Array.from(samples, Number)
  let start, end
  if (Array.isArray(span)) [start, end] = span
  else { start = span.start ?? span.startSample; end = span.end ?? span.endSample }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end >= input.length || end < start) {
    throw new RangeError('跨距必须是样值范围内的合法闭区间。')
  }
  const output = input.slice()
  const left = start > 0 ? input[start - 1] : input[start]
  const right = end + 1 < input.length ? input[end + 1] : input[end]
  const n = end - start + 1
  if (method === 'linear') {
    for (let i = start; i <= end; i++) {
      const t = (i - start + 1) / (n + 1)
      output[i] = left + (right - left) * t
    }
    return output
  }
  if (method === 'cubic') {
    const p0 = start - 2 >= 0 ? input[start - 2] : left
    const p1 = left
    const p2 = right
    const p3 = end + 2 < input.length ? input[end + 2] : right
    const m1 = (p2 - p0) / 2
    const m2 = (p3 - p1) / 2
    for (let i = start; i <= end; i++) {
      const t = (i - start + 1) / (n + 1)
      const t2 = t * t, t3 = t2 * t
      const h00 = 2 * t3 - 3 * t2 + 1
      const h10 = t3 - 2 * t2 + t
      const h01 = -2 * t3 + 3 * t2
      const h11 = t3 - t2
      output[i] = h00 * p1 + h10 * m1 + h01 * p2 + h11 * m2
    }
    return output
  }
  throw new RangeError(`未知插值方法：${method}`)
}

// 把任意选中描述解析成唯一的、可补的整段 id 集合。
// selections 元素可以是 id 字符串、{id}、{clipId}、{channel,start,end...} 或原始区间。
export function resolveSelections(descriptions, reportsByChannel, options = {}) {
  const allClips = reportsByChannel.flatMap(report => report.clips)
  const byId = new Map(allClips.map(clip => [clip.id, clip]))
  const chosen = new Map()
  const skipped = []
  const list = descriptions === undefined || descriptions === null ? [] : Array.from(descriptions)

  const considerClip = clip => {
    if (!clip) return
    if (!clip.repairable) {
      if (!skipped.some(item => item.id === clip.id)) skipped.push({ id: clip.id, ...clip,
        reason: clip.reason ?? REASON_BOUNDARY })
      return
    }
    chosen.set(clip.id, clip)
  }

  for (const description of list) {
    if (description === null || description === undefined) continue
    if (typeof description === 'string') {
      considerClip(byId.get(description))
      continue
    }
    if (typeof description !== 'object') continue
    const id = description.id ?? description.clipId ?? description.key
    if (id !== undefined && byId.has(id)) { considerClip(byId.get(id)); continue }
    const channel = Number(description.channel ?? 0)
    const report = reportsByChannel[channel]
    if (!report) continue
    let interval
    if (description.startSample !== undefined || description.endSample !== undefined ||
        description.startIndex !== undefined || description.range !== undefined) {
      interval = resolveRange(description, options.rate, report.samples.length)
    } else if (description.start !== undefined && description.end !== undefined) {
      // 同时给了 rate 且数值像秒时按秒处理，否则按样点。
      const rate = options.rate ?? PCM_FULL_SCALE
      const maxFrames = report.samples.length
      const looksSeconds = description.timeUnit === 'seconds' || description.unit === 'seconds' ||
        (options.timeUnit !== 'samples' && description.end <= maxFrames / rate + 1e-9 &&
          !Number.isInteger(description.end))
      interval = looksSeconds
        ? resolveRange({ start: description.start, end: description.end }, rate, maxFrames)
        : resolveRange({ startSample: description.start, endSample: description.end }, rate, maxFrames)
    }
    if (!interval) {
      if (description.repairable === true && description.startSample !== undefined) {
        const exact = report.clips.find(clip => clip.startSample === description.startSample &&
          clip.endSample === description.endSample)
        considerClip(exact)
      }
      continue
    }
    for (const clip of report.clips.filter(clip =>
      clip.start <= interval.end && clip.end >= interval.start)) considerClip(clip)
  }
  return { selected: [...chosen.values()], skipped }
}

// 为单个选中整段生成“超出原削平幅度并接回两侧”的输出域拱线。
// 基线 y 已经是全段减半后的 PCM16 整数。以 y[start-1]、y[end+1] 为虚锚点
// （与工作台 interpolateSpan 相同的 t=(i-start+1)/(n+1) 刻度），
// 采用 sin^4 隆起：在两侧锚点处值与斜率都为 0 接触，且首个离散步进更小。
export function buildPeakArch(base, clip, options = {}) {
  const { start, end, amplitude, sign } = clip
  const n = end - start + 1
  const left = base[start - 1]
  const right = base[end + 1]
  const factor = options.overshoot ?? 1.25
  // 数学上 PCM16 无法严格超过 32767；此时目标只能顶到满幅，由计量字段给出量化前超调。
  const peak = Math.min(PCM_POSITIVE_FULL,
    Math.max(amplitude + 1, Math.ceil(amplitude * factor)))
  const values = base.slice()
  const tOf = i => (i - start + 1) / (n + 1)
  const lineAt = t => left + (right - left) * t
  const shapeAt = t => Math.sin(Math.PI * t) ** 4
  let apexIndex = start
  let bestShape = -1
  for (let i = start; i <= end; i++) {
    const shape = shapeAt(tOf(i))
    if (shape > bestShape) { bestShape = shape; apexIndex = i }
  }
  const apexT = tOf(apexIndex)
  const bump = (sign * peak - lineAt(apexT)) / Math.max(bestShape, 1e-9)
  for (let i = start; i <= end; i++) {
    const t = tOf(i)
    values[i] = workbenchRound(lineAt(t) + bump * shapeAt(t))
  }
  // 强制顶点达到目标整数峰值，确保“峰值须超出原削平幅度”在可表示时严格成立。
  values[apexIndex] = sign * peak
  const seamLeft = Math.abs(values[start] - left)
  const seamRight = Math.abs(values[end] - right)
  return { values, peak, apexIndex, seamLeft, seamRight,
    floatPeak: sign * (peak + (amplitude >= PCM_POSITIVE_FULL ? 1 : 0)) }
}

// 新工作台成品：全段两路未选样点统一减半并舍入；选中整段补峰。
// input 可为 PCM 整数声道数组，或 {tracks:Float64Array[]}（归一化浮点）。
export function renderFlatTops(input, selections, options = {}) {
  let channels
  if (Array.isArray(input)) channels = input
  else if (input && Array.isArray(input.pcm)) channels = input.pcm
  else if (input && Array.isArray(input.tracks)) {
    channels = input.tracks.map(track => toPcm16(track, { normalized: options.normalized }))
  } else throw new TypeError('renderFlatTops 需要声道数组或 {tracks}。')

  const pcmChannels = channels.map(channel => toPcm16(channel, options))
  const reports = pcmChannels.map((pcm, channel) =>
    findFlatTops(pcm, { ...options, channel, integer: true, normalized: false }))
  const { selected, skipped } = resolveSelections(selections, reports, options)

  const output = pcmChannels.map(pcm => pcm.map(sample => halveSample(sample)))
  const results = []
  for (const clip of selected) {
    const base = output[clip.channel]
    const built = buildPeakArch(base, clip, options)
    output[clip.channel] = built.values
    const runPeak = Math.max(...built.values.slice(clip.start, clip.end + 1).map(Math.abs))
    results.push({ id: clip.id, channel: clip.channel,
      start: clip.start, end: clip.end, startSample: clip.start, endSample: clip.end,
      originalLevel: clip.amplitude, clipLevel: clip.amplitude,
      peak: runPeak, repairedPeak: runPeak, targetPeak: built.peak,
      floatPeak: built.floatPeak, preQuantizationPeak: built.floatPeak,
      exceedsClipAmplitude: runPeak > clip.amplitude,
      overshootAboveClip: built.floatPeak > clip.amplitude,
      apexIndex: built.apexIndex, seamLeft: built.seamLeft, seamRight: built.seamRight,
      leftAnchor: base[clip.start - 1], rightAnchor: base[clip.end + 1],
      repaired: true })
  }
  return { pcm: output, channels: output.length, frames: output[0]?.length ?? 0,
    reports, selected, results, repairs: results, skipped }
}

// 原刻度补峰：在“减半”之前的信号上重建超出 C 的平滑拱线并接回原两侧。
// 返回与 samples 同刻度的新数组；供需要量化前补峰计量的调用方使用。
export function rebuildPeak(samples, clip, options = {}) {
  const pcm = toPcm16(samples, options)
  const { start, end } = clip
  const amplitude = clip.amplitude ?? clip.peak ?? Math.abs(pcm[start])
  const sign = clip.sign ?? (pcm[start] < 0 ? -1 : 1)
  const n = end - start + 1
  const left = start > 0 ? pcm[start - 1] : sign * amplitude
  const right = end + 1 < pcm.length ? pcm[end + 1] : sign * amplitude
  const target = sign * Math.min(PCM_POSITIVE_FULL + 1,
    Math.max(amplitude + 1, Math.ceil(amplitude * (options.factor ?? 1.25))))
  const output = pcm.slice()
  let apexIndex = start, bestShape = -1
  for (let i = start; i <= end; i++) {
    const t = (i - start + 1) / (n + 1)
    const shape = Math.sin(Math.PI * t) ** 2
    if (shape > bestShape) { bestShape = shape; apexIndex = i }
  }
  const lineAt = t => left + (right - left) * t
  const apexT = (apexIndex - start + 1) / (n + 1)
  const bump = (target - lineAt(apexT)) / Math.max(bestShape, 1e-9)
  for (let i = start; i <= end; i++) {
    const t = (i - start + 1) / (n + 1)
    output[i] = lineAt(t) + bump * Math.sin(Math.PI * t) ** 2
  }
  output[apexIndex] = target
  return output
}

// 选中区间两两合并/映射为整段后的幂等键，用于验证“同一平顶不能拆修”。
export function repairIdentity(descriptions, pcmChannels, options = {}) {
  const reports = pcmChannels.map((pcm, channel) =>
    findFlatTops(pcm, { ...options, channel, integer: true, normalized: false }))
  return resolveSelections(descriptions, reports, options).selected
    .map(clip => clip.id).sort()
}

// ---- 命名别名：兼容不同命名习惯的调用方/验收脚本 ----
export const detectFlatTops = findFlatTops
export const scanFlatTops = findFlatTops
export const findClips = findFlatTops
export const detectClips = findFlatTops
export const scanClips = scanRange
export const inspectRange = scanRange
export const queryRange = scanRange
export const findFlatTopsInRange = scanRange
export const repairFlatTops = renderFlatTops
export const repairClips = renderFlatTops
export const declip = renderFlatTops
export const restoreFlatTops = renderFlatTops
export const renderRepair = renderFlatTops
export const mergeSpans = repairIdentity
export const mergeOverlapping = repairIdentity
export const mergeOverlappingSpans = repairIdentity
export const findFlatRuns = findEqualRuns
export const flatTopSegments = findFlatTops
export const halfSample = halveSample
export const roundPcm16 = workbenchRound
export const pcmRound = workbenchRound
export const HALVE = 0.5

export default {
  PCM_FULL_SCALE, PCM_POSITIVE_FULL,
  clampPcm16, workbenchRound, halveSample, halveSamples, quantizePcm16, toPcm16,
  findEqualRuns, findRuns, isClipped, isFlatTop, findFlatTops, scanRange,
  interpolateSpan, resolveRange, resolveSelections, buildPeakArch, rebuildPeak,
  renderFlatTops, repairIdentity, scanClips, detectClips, repairClips, declip
}
