import { InputError } from '../http/error.mjs'
import { MAX_REGIONS, MAX_AUDITION_SECONDS, WINDOW_SIZES } from '../audio/limits.mjs'

export function parseSize(value) {
  const size = Number(value ?? 512)
  if (!WINDOW_SIZES.includes(size)) throw new InputError('窗长应为 256、512 或 1024 采样。')
  return size
}

export function parseRegions(value, info) {
  let list
  try {
    list = value ? JSON.parse(value) : []
  } catch {
    throw new InputError('选区参数无法解析。')
  }
  if (!Array.isArray(list) || list.length > MAX_REGIONS) {
    throw new InputError(`最多可以叠加 ${MAX_REGIONS} 个频谱选区。`)
  }
  const duration = info.frames / info.rate, nyquist = info.rate / 2
  return list.map(region => {
    const { start, end, low, high, db } = region ?? {}
    if (![start, end, low, high, db].every(Number.isFinite) || start < 0 || end <= start || end > duration ||
        low < 0 || high <= low || high > nyquist || db < 0 || db > 60) {
      throw new InputError('频谱选区需要有效的时段、频带与 0–60 dB 衰减。')
    }
    return { start, end, low, high, db }
  })
}

export function parseRange(value, info, maxSeconds) {
  const start = Number(value?.start ?? 0)
  const requested = Number(value?.end ?? info.frames / info.rate)
  const duration = info.frames / info.rate
  if (!Number.isFinite(start) || !Number.isFinite(requested) || start < 0 || start >= duration) {
    throw new InputError('试听范围的起点无效。')
  }
  if (requested < start || requested > duration) throw new InputError('试听范围的终点无效。')
  if (requested - start > maxSeconds + 1e-9) {
    throw new InputError(`单次试听长度不能超过 ${MAX_AUDITION_SECONDS} 秒。`)
  }
  return { start, end: requested }
}

export function assertAuditionLimit(range) {
  if (range.end - range.start > MAX_AUDITION_SECONDS + 1e-9) {
    throw new InputError(`单次试听长度不能超过 ${MAX_AUDITION_SECONDS} 秒。`)
  }
}
