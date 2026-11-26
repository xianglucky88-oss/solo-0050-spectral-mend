import { InputError } from '../http/error.mjs'

export function windowPlan(frames, size = 512) {
  if (![256,512,1024].includes(size)) throw new InputError('窗长应为 256、512 或 1024 采样。')
  const hop = size / 4
  const window = Float64Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / size))
  const starts = []
  for (let start = hop - size; start < frames; start += hop) starts.push(start)
  return { size, hop, window, starts }
}
