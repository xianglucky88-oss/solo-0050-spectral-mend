// 落锁接口入参规范化。核心契约是“零起算整数帧 + 半开区间”，
// 同时兼容常见别名字段与秒/帧单位，方便不同调用方与页面表单。
import { InputError } from '../http/error.mjs'

const FRAME_UNITS = new Set(['frame', 'frames', 'sample', 'samples', 'index', 'indices', '帧'])
const SECOND_UNITS = new Set(['second', 'seconds', 'sec', 's', '秒'])

function asFrame(value, rate, unit) {
  if (value === undefined || value === null || value === '') return null
  if (typeof value === 'string') value = Number(value)
  if (!Number.isFinite(value)) return null
  let u = unit
  if (typeof u === 'string') u = u.toLowerCase()
  if (FRAME_UNITS.has(u)) return Math.round(value)
  if (SECOND_UNITS.has(u)) return Math.round(value * rate)
  // 缺省：整数按零起算帧，小数按秒（帧号不会是小数）。
  return Number.isInteger(value) ? value : Math.round(value * rate)
}

function rangeFrom(raw, rate, unit) {
  if (!raw) return null
  if (Array.isArray(raw)) return { start: asFrame(raw[0], rate, unit), end: asFrame(raw[1], rate, unit) }
  const start = raw.start ?? raw.from ?? raw.lo ?? raw.begin ?? raw.startFrame ?? raw.startSample
  const end = raw.end ?? raw.to ?? raw.hi ?? raw.finish ?? raw.endFrame ?? raw.endSample
  const u = raw.unit ?? raw.timeUnit ?? unit
  return { start: asFrame(start, rate, u), end: asFrame(end, rate, u) }
}

function segmentFrom(input, rate) {
  const unit = input.unit ?? input.timeUnit ?? input.frameUnit
  const raw = input.segment ?? input.circle ?? input.range ?? input.span ?? input.change
    ?? input.changedSegment ?? input.selection ?? input.region ?? null
  if (raw) {
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      const r = rangeFrom(raw, rate, raw.unit ?? unit)
      if (r) return r
    }
    const r = rangeFrom(raw, rate, unit)
    if (r) return r
  }
  if (input.segmentStart !== undefined || input.segmentEnd !== undefined) {
    // 字段名已标明 Frame：无论全局 unit 是什么，都按零起算帧处理。
    return { start: asFrame(input.segmentStart ?? input.segStart, rate, 'frames'),
      end: asFrame(input.segmentEnd ?? input.segEnd, rate, 'frames') }
  }
  if (input.startSample !== undefined || input.endSample !== undefined ||
      input.startFrame !== undefined || input.endFrame !== undefined) {
    return { start: asFrame(input.startSample ?? input.startFrame ?? input.from, rate, 'frames'),
      end: asFrame(input.endSample ?? input.endFrame ?? input.to, rate, 'frames') }
  }
  if (input.start !== undefined && input.end !== undefined) {
    return { start: asFrame(input.start, rate, unit), end: asFrame(input.end, rate, unit) }
  }
  return null
}

function locksFrom(input) {
  const list = input.locks ?? input.cues ?? input.impacts ?? input.items ?? input.moves
    ?? input.shots ?? input.hits ?? input.landings
  if (Array.isArray(list)) return list
  // 并行数组形态：searches/ranges + targets/targetFrames + optional sourceFrames
  const searches = input.searches ?? input.searchRanges ?? input.ranges
  const targets = input.targets ?? input.targetFrames
  if (Array.isArray(searches)) {
    return searches.map((search, i) => ({
      search,
      target: Array.isArray(targets) ? targets[i] : undefined,
      source: Array.isArray(input.sourceFrames) ? input.sourceFrames[i] : undefined
    }))
  }
  return null
}

export function parseLockRequest(input, audio) {
  if (!input || typeof input !== 'object') throw new InputError('请求需要 JSON 参数。')
  const rate = audio.rate
  const unit = input.unit ?? input.timeUnit ?? input.frameUnit
  const segment = segmentFrom(input, rate)
  if (!segment || !Number.isInteger(segment.start) || !Number.isInteger(segment.end) || segment.end <= segment.start) {
    throw new InputError('请先圈出有效的改动段（零起算首尾帧）。')
  }
  if (segment.start < 0 || segment.end > audio.frames) {
    throw new InputError('改动段超出音频范围。')
  }

  const rawLocks = locksFrom(input)
  if (!Array.isArray(rawLocks) || rawLocks.length === 0) {
    throw new InputError('请为每次落锁填写原声搜索范围和目标帧。')
  }

  const locks = rawLocks.map((lock, index) => {
    const searchRaw = lock.search ?? lock.searchRange ?? lock.range ?? lock.sourceRange
      ?? lock.originalRange ?? lock.find ?? lock.circle ?? lock
    const search = rangeFrom(searchRaw, rate, lock.unit ?? unit)
    // 名为 *Frame/*Index 的目标一定是零起算帧；其余别名字段跟随 unit/自动推断。
    const explicitTarget = lock.targetFrame ?? lock.targetStartFrame ?? lock.targetIndex
    const targetFrame = explicitTarget !== undefined && explicitTarget !== null
      ? asFrame(explicitTarget, rate, 'frames')
      : asFrame(lock.target ?? lock.to ?? lock.destination ?? lock.dest ?? lock.at ?? lock.targetStart,
        rate, lock.unit ?? unit)
    const explicitSource = lock.sourceFrame ?? lock.zeroBasedSourceFrame ?? lock.sourceIndex
    const sourceFrame = explicitSource !== undefined && explicitSource !== null
      ? asFrame(explicitSource, rate, 'frames')
      : asFrame(lock.source ?? lock.sourceStart ?? lock.from, rate, lock.unit ?? unit)
    return { index, search, targetFrame, sourceFrame: Number.isInteger(sourceFrame) ? sourceFrame : null }
  })

  const frequencies = Array.isArray(input.frequencies) ? input.frequencies.map(Number).filter(Number.isFinite)
    : Array.isArray(input.stems) ? input.stems.map(Number).filter(Number.isFinite) : null
  return {
    segment: [segment.start, segment.end],
    locks,
    frequencies: frequencies?.length ? frequencies : null,
    tolerance: Number.isFinite(input.tolerance) ? input.tolerance : 0.05,
    detect: input.detect !== false,
    options: input.options ?? {}
  }
}
