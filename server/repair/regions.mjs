import { InputError } from '../http/error.mjs'

export function regions(input, audio) {
  if (!Array.isArray(input) || input.length > 8) throw new InputError('最多可以叠加 8 个频谱选区。')
  return input.map(region => {
    const { start, end, low, high, db } = region ?? {}
    if (![start,end,low,high,db].every(Number.isFinite) || start < 0 || end <= start || end > audio.frames / audio.rate ||
        low < 0 || high <= low || high > audio.rate / 2 || db < 0 || db > 60) {
      throw new InputError('频谱选区需要有效的时段、频带与 0–60 dB 衰减。')
    }
    return { start, end, low, high, db }
  })
}
