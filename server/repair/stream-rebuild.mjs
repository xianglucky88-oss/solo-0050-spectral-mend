import { transform } from '../spectrum/transform.mjs'
import { spectrumFrame } from '../spectrum/frame.mjs'
import { applyGains } from './mirror.mjs'
import { bandGains } from './band-gains.mjs'
import { readFrames } from '../audio/scan.mjs'

// 有界内存的流式重建。窗口按起点升序逐扇读入，环形缓存只保留约两个窗长的状态，
// 处理完的采样立刻量化送出，工作内存不随总帧数增长。
//
// 重叠相加（OLA）恒等式：对周期 Hann 窗、跳距 hop=size/4，有 Σ_j w_j² = 常数，
// 归一化输出帧 f = Σ_j w_j·x'_j(f) / Σ_j w_j²。
// 把加窗修复值拆成 源项 w·(w·source) 与 修复增量 w·(x' − w·source)：
//   输出 = 源 + Σ w·(x' − w·source) / Σ w²
// 圈外频格增益严格为 1.0，x' = w·source，增量为零，因此圈外输出与源逐样相同。
//
// 送出不变量：帧 f 的贡献窗满足 start ≤ f < start+size，最晚贡献窗起点恰为 f，
// 处理完窗 start 后所有帧号 < start 的帧已收齐全部贡献窗。
//
// ownFrom/ownTo 是本次写出的帧区间；分析窗按窗长向两侧扩展，跨界窗仍完整参与，
// 每个采样帧只由拥有它的分段写出，分段拼接与整段处理逐样一致。
export async function streamRepair(handle, info, plan, regionList, sink,
  ownFrom = 0, ownTo = info.frames) {
  const { rate, frames, channels } = info
  ownFrom = Math.max(0, ownFrom)
  ownTo = Math.min(frames, ownTo)

  // 无选区：归一化恒等，直接量化源采样，旁路与源逐字节相同且跳过 FFT。
  if (regionList.length === 0) {
    const block = await readFrames(handle, info, ownFrom, ownTo - ownFrom)
    const samples = new Int16Array(channels)
    for (let i = 0; i < block.count; i++) {
      for (let c = 0; c < channels; c++) samples[c] = quantize(block.tracks[c][i])
      sink(samples, ownFrom + i)
    }
    return { emitted: block.count, editedWindows: 0 }
  }

  const first = Math.max(0, ownFrom - plan.size)
  const last = Math.min(frames, ownTo + plan.size)
  const capacity = 1 << Math.ceil(Math.log2(plan.size * 2 + 1))
  const mask = capacity - 1
  // 源项累加器 Σ w²·source；修复增量累加器 Σ w·(x' − w·source)；权重 Σ w²。
  const sourceAcc = Array.from({ length: channels }, () => new Float64Array(capacity))
  const deltaAcc = Array.from({ length: channels }, () => new Float64Array(capacity))
  const weight = new Float64Array(capacity)
  const initialized = new Uint8Array(capacity)
  let base = ownFrom, emitted = 0, editedWindows = 0

  function emitUpTo(limit) {
    while (base < ownTo && base < limit) {
      const slot = base & mask
      const w = weight[slot]
      const samples = new Int16Array(channels)
      for (let c = 0; c < channels; c++) {
        // sourceAcc/w = source（恒等），deltaAcc/w 为衰减带来的纯增量。
        const value = sourceAcc[c][slot] / w + deltaAcc[c][slot] / w
        samples[c] = quantize(value)
      }
      sink(samples, base)
      initialized[slot] = 0
      weight[slot] = 0
      for (let c = 0; c < channels; c++) {
        sourceAcc[c][slot] = 0
        deltaAcc[c][slot] = 0
      }
      base++
      emitted++
    }
  }

  for (const start of plan.starts) {
    if (start >= last || start + plan.size <= first) continue
    const centerTime = (start + plan.size / 2) / rate
    const gains = bandGains(plan, rate, frames, centerTime, regionList)
    if (gains) editedWindows++
    const from = Math.max(0, -start), to = Math.min(plan.size, frames - start)
    const readAt = Math.max(0, start)
    const block = await readFrames(handle, info, readAt, to - from) // 紧凑块，索引 i-from
    const edited = gains ? block.tracks.map(track => {
      // 构造窗长视图：文件头/尾的补零区保留为 0，有效采样放在窗内正确位置。
      // 以 start=0 做频谱变换，避免 spectrumFrame 用绝对起点在紧凑视图上越界。
      const view = new Float64Array(plan.size)
      view.set(track, from)
      const frame = spectrumFrame(view, 0, plan)
      applyGains(frame, gains)
      transform(frame.real, frame.imaginary, true)
      return frame.real
    }) : null
    for (let i = from; i < to; i++) {
      const frameIndex = start + i
      if (frameIndex < ownFrom || frameIndex >= ownTo) continue
      const slot = frameIndex & mask, w = plan.window[i]
      const blockIndex = i - from
      if (!initialized[slot]) {
        initialized[slot] = 1
        weight[slot] = 0
        for (let c = 0; c < channels; c++) {
          sourceAcc[c][slot] = 0
          deltaAcc[c][slot] = 0
        }
      }
      weight[slot] += w * w
      for (let c = 0; c < channels; c++) {
        const source = block.tracks[c][blockIndex]
        sourceAcc[c][slot] += w * w * source
        if (gains) {
          // edited[c][i] 即加窗修复值 x'；w·source 即加窗源值。
          deltaAcc[c][slot] += w * (edited[c][i] - w * source)
        }
      }
    }
    emitUpTo(start)
  }
  emitUpTo(ownTo)
  return { emitted, editedWindows }
}

function quantize(value) {
  return Math.max(-32768, Math.min(32767, Math.round(value * 32768)))
}
