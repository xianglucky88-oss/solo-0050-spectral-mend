import { InputError } from '../http/error.mjs'

function number(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new InputError(`${label}需要是有限数值。`)
  return value
}

function integerList(values, label) {
  if (!Array.isArray(values) || values.length === 0 || values.length > 16) {
    throw new InputError(`${label}需要是 1–16 个数值的数组。`)
  }
  return values.map(value => number(value, label))
}

export function parseGlideParams(input, audio) {
  if (!input || typeof input !== 'object') throw new InputError('缺少上滑音参数。')
  const duration = audio.frames / audio.rate
  const start = number(input.start, '开始时间')
  const end = number(input.end, '结束时间')
  if (start < 0 || end <= start || end > duration) {
    throw new InputError('圈选时段需要落在录音时长内，且结束晚于开始。')
  }
  const low = number(input.low, '基频搜索下限')
  const high = number(input.high, '基频搜索上限')
  const nyquist = audio.rate / 2
  if (low <= 0 || high <= low || high > nyquist) {
    throw new InputError('基频搜索范围需要为正数，且不超过奈奎斯特频率。')
  }
  const orders = integerList(input.orders, '谐波阶数')
  const sidebands = integerList(input.sidebands, '边带半宽')
  if (sidebands.length !== 1 && sidebands.length !== orders.length) {
    throw new InputError('各阶边带半宽数量应与谐波阶数一致，或只给一个统一值。')
  }
  const widthOf = index => sidebands.length === 1 ? sidebands[0] : sidebands[index]
  const harmonics = orders.map((order, index) => {
    if (!Number.isInteger(order) || order < 1 || order > 64) {
      throw new InputError('谐波阶数需要是 1–64 的整数。')
    }
    const width = widthOf(index)
    if (width <= 0 || width > nyquist / 2) throw new InputError('边带半宽需要为正数且不超过奈奎斯特频率的一半。')
    return { order, width }
  })
  if (new Set(harmonics.map(item => item.order)).size !== harmonics.length) {
    throw new InputError('谐波阶数不能重复。')
  }
  harmonics.sort((a, b) => a.order - b.order)
  const targetStart = number(input.targetStart, '目标基频起点')
  const targetEnd = number(input.targetEnd, '目标基频终点')
  if (targetStart <= 0 || targetEnd <= 0 || targetEnd <= targetStart) {
    throw new InputError('目标基频起止值需要为正数，且终点高于起点（上滑音）。')
  }
  return { start, end, low, high, harmonics, targetStart, targetEnd, duration, nyquist }
}

export function hardGuards(params) {
  const guards = []
  if (params.end - params.start < 0.04) guards.push('圈选时段短于 40 毫秒，拒绝生成。')
  for (const { order, width } of params.harmonics) {
    const lowest = Math.min(order * params.targetStart, order * params.targetEnd) - width
    const highest = Math.max(order * params.targetStart, order * params.targetEnd) + width
    if (lowest <= 0) guards.push(`第 ${order} 阶目标频带连同边带触及 0 Hz，拒绝生成。`)
    if (highest >= params.nyquist) guards.push(`第 ${order} 阶目标频带连同边带触及奈奎斯特频率 ${params.nyquist} Hz，拒绝生成。`)
  }
  return guards
}
