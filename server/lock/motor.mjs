// 电机声床修复：用稳态声线最小二乘拟合 + 双端相位/幅度连续外推，
// 填补搬走撞击后留下的源保护片空洞。只在段内可编辑区写入。
import { fitStems } from './envelope.mjs'

const CONTEXT = 256

function fitSide(channel, lo, hi, rate, frequencies, side) {
  const from = side === 'left' ? Math.max(0, lo - CONTEXT) : hi
  const to = side === 'left' ? lo : Math.min(channel.length, hi + CONTEXT)
  const fits = fitStems(channel, from, to, frequencies, rate)
  return { from, to, list: fits.map((fit, i) => ({ freq: frequencies[i], C: fit.C, Q: fit.Q, from })) }
}

// 直接按绝对帧合成，避免窗原点歧义。
function renderSide(side, absoluteIndex, rate) {
  let sum = 0
  for (const { freq, C, Q, from } of side.list) {
    const n = absoluteIndex - from
    const theta = 2 * Math.PI * freq / rate
    sum += C * Math.cos(theta * n) + Q * Math.sin(theta * n)
  }
  return sum
}

// 重建单声道的 [lo,hi)（整数帧），返回整数数组（仅该区间长度）。
export function reconstructInterval(channel, lo, hi, { rate, frequencies }) {
  const left = fitSide(channel, lo, hi, rate, frequencies, 'left')
  const right = fitSide(channel, lo, hi, rate, frequencies, 'right')
  const length = hi - lo
  const out = new Array(length)
  const x = i => channel[i] / 32768

  // 边界残差校正，保证与区间外固定样点平滑相接。
  const leftAtLoMinus1 = renderSide(left, lo - 1, rate)
  const rightAtHi = renderSide(right, hi, rate)
  const errL = (lo - 1 >= 0 ? x(lo - 1) : 0) - leftAtLoMinus1
  const errR = (hi < channel.length ? x(hi) : rightAtHi) - rightAtHi

  for (let k = 0; k < length; k++) {
    const i = lo + k
    const u = length === 1 ? 1 : k / (length - 1)
    const w = u * u * (3 - 2 * u) // smoothstep：左端偏左模型，右端偏右模型
    let value = (1 - w) * renderSide(left, i, rate) + w * renderSide(right, i, rate)
    value += (1 - u) * errL + u * errR
    out[k] = clampInt16(Math.round(value * 32768))
  }
  return out
}

export function clampInt16(v) {
  return v > 32767 ? 32767 : v < -32768 ? -32768 : v
}

// 线性 + 等功率淡变工具。
export function mix(a, b, w) {
  return Math.round(clampInt16((a * (1 - w) + b * w)))
}
