import { transform } from './transform.mjs'
import { readFrames } from '../audio/scan.mjs'
import { SPECTRUM_COLUMNS } from '../audio/limits.mjs'

// 仅计算可见时间范围 [viewStart, viewEnd) 内的窗，聚合为最多 160 列。
// 无论总时长多长，参与计算的窗数都被视区宽度限定，工作内存有界。
// 分贝、双声道功率合并、列内取最大值的规则与旧版 columns 完全相同。
export async function viewColumns(handle, info, plan, viewStart = 0, viewEnd = info.frames / info.rate) {
  const { rate, frames, channels } = info
  const duration = frames / rate
  viewStart = Math.max(0, Math.min(duration, viewStart))
  viewEnd = Math.max(viewStart, Math.min(duration, viewEnd))
  const starts = plan.starts.filter(start => {
    const center = (start + plan.size / 2) / rate
    return center >= viewStart && center < viewEnd
  })
  const width = Math.min(SPECTRUM_COLUMNS, starts.length), bins = plan.size / 2 + 1
  const values = Array.from({ length: width }, () => Array(bins).fill(-100))
  const centers = []
  for (const [index, start] of starts.entries()) {
    const center = (start + plan.size / 2) / rate
    const column = Math.floor(index * width / starts.length)
    if (!centers[column]) centers[column] = { first: center, last: center }
    else centers[column].last = center
    const from = Math.max(0, -start), to = Math.min(plan.size, frames - start)
    const readAt = Math.max(0, start)
    const block = await readFrames(handle, info, readAt, to - from)
    const powers = new Float64Array(bins)
    for (let c = 0; c < channels; c++) {
      const real = new Float64Array(plan.size), imaginary = new Float64Array(plan.size)
      for (let i = from; i < to; i++) real[i] = block.tracks[c][i - from] * plan.window[i]
      transform(real, imaginary)
      for (let k = 0; k < bins; k++) powers[k] += real[k] ** 2 + imaginary[k] ** 2
    }
    for (let k = 0; k < bins; k++) {
      const power = powers[k] / channels
      const scale = (k === 0 || k === bins - 1 ? 2 : 4) / plan.size
      const db = 10 * Math.log10(Math.max(1e-10, power * scale ** 2))
      values[column][k] = Math.max(values[column][k], Math.round(db))
    }
  }
  return { values, centers, binHz: rate / plan.size, duration, viewStart, viewEnd }
}
